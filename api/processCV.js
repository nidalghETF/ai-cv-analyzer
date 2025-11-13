// api/processCV.js
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- Configuration ---
const CONFIG = {
  API_KEY_NAME: "GOOGLE_AI_API_KEY", // This name is fine for explicit access via process.env
  MODEL_NAME: process.env.GEMINI_MODEL || "gemini-2.5-flash", // Changed model name
  MAX_PDF_SIZE_MB: parseInt(process.env.MAX_PDF_SIZE_MB) || 5,
  TIMEOUT_MS: parseInt(process.env.AI_TIMEOUT_MS) || 60000,
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(o => o),
  CORS_ENABLED: process.env.CORS_ENABLED !== 'false'
};

// --- Core Initialization (moved inside try block) ---
let genAI, model;

// --- Security & Validation Utilities ---
const SecurityUtils = {
  /**
   * Validates base64 string format and estimated size
   * @throws {Error} if validation fails
   */
  validateBase64: (str, fieldName = 'pdfBase64') => {
    if (typeof str !== 'string' || str.length === 0) {
      throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
    }
    // Basic base64 validation - check for invalid characters (allow whitespace)
    if (!/^[A-Za-z0-9+/=\s]+$/.test(str)) {
      throw new Error(`Invalid ${fieldName}: contains non-base64 characters`);
    }
    // Size check (base64 size ≈ 1.37x original, we check the string itself)
    const estimatedSizeInBytes = (str.replace(/\s/g, '').length * 0.75);
    const maxSize = CONFIG.MAX_PDF_SIZE_MB * 1024 * 1024;
    if (estimatedSizeInBytes > maxSize) {
      throw new Error(`PDF size exceeds limit of ${CONFIG.MAX_PDF_SIZE_MB}MB`);
    }
    return true;
  },
  /**
   * Extracts and sanitizes JSON from AI response
   * @throws {Error} if no valid JSON found
   */
  extractJson: (responseText) => {
    // Remove markdown code fences and extract JSON
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```|([\s\S]+)/);
    const jsonString = (jsonMatch ? (jsonMatch[1] || jsonMatch[2]) : responseText).trim();
    if (!jsonString) {
      throw new Error("AI response contained no parseable content");
    }
    // Remove control characters except whitespace
    return jsonString.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  }
};

// --- CORS Handler ---
const CorsUtils = {
  /**
   * Sets appropriate CORS headers on the response
   */
  setHeaders: (response, requestOrigin) => {
    if (!CONFIG.CORS_ENABLED) return;
    const isAllowed = CONFIG.ALLOWED_ORIGINS.length === 0 ||
                     CONFIG.ALLOWED_ORIGINS.includes(requestOrigin) ||
                     CONFIG.ALLOWED_ORIGINS.includes('*');
    if (isAllowed) {
      response.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Max-Age', '86400');
    }
  }
};

// --- AI Prompt Template ---
const SYSTEM_PROMPT = `
CRITICAL: You are a PRECISION DATA EXTRACTOR. Follow this TWO-STAGE process:

## STAGE 1: LITERAL EXTRACTION (NON-NEGOTIABLE)
Extract EXACT text for these fields FROM THE CV TEXT. NO INFERENCE YET.

**PERSONAL INFO - FIND EXACT MATCHES:**
- "Full Name": Scan headers, top-center, contact sections. Extract ANY name pattern.
- "Professional Title": Current/most recent job title. Copy EXACT title text.
- "Phone": Find phone patterns: xxx-xxx-xxxx, (xxx) xxx-xxxx, +x xxx xxx xxxx
- "Email": Find email patterns: name@domain.com, name@company.com
- "Location": City, State from address blocks, contact info
- "LinkedIn": URLs containing "linkedin.com/in/"
- "Portfolio": URLs with "github.com", "portfolio", personal domains

**CONTACT INFO EXTRACTION COMMAND:**
IF any contact info exists in CV → EXTRACT IT LITERALLY
IF no contact info found → leave empty (will infer in Stage 2)

## STAGE 2: CONTENT EXTRACTION (COMPREHENSIVE)

**PROFESSIONAL SUMMARY:**
- PRIMARY: Extract from "Summary", "Profile", "Objective" sections
- FALLBACK: If none, create 2-3 sentence summary from experience highlights
- NEVER leave empty

**CORE COMPETENCIES:**
- "Technical Skills": Extract ALL from "Skills", "Technical", "Technologies" sections + tools mentioned in experience
- "Soft Skills": Extract from "Strengths", "Attributes" or infer from achievement descriptions
- FORMAT: Comma-separated, preserve original terminology

**EXPERIENCE & EDUCATION (MANDATORY FIELDS):**
- Extract EVERY role: Job Title, Company, Dates, Location
- Responsibilities: Key daily tasks from job descriptions
- Achievements: Quantified results, awards, promotions
- Education: ALL degrees with Institution, Degree, Dates

**ADDITIONAL SECTIONS:**
- Search thoroughly for: Projects, Publications, Memberships, Volunteer work
- If sections exist → EXTRACT
- If no sections → leave empty (not applicable)

## STAGE 3: INTELLIGENT COMPLETION (ONLY FOR EMPTY FIELDS)

**ONLY IF FIELD IS EMPTY AFTER LITERAL EXTRACTION:**

- "Full Name": If empty after search → use name from email address OR "Not Specified"
- "Professional Title": If empty → use most recent job title from experience
- "Location": If empty → use location from most recent job
- "Phone/Email": If empty → leave empty (privacy)
- "LinkedIn/Portfolio": If empty → leave empty

## OUTPUT VALIDATION CHECKLIST:
✅ Personal Info: At least Name and Title should have values  
✅ Experience: Minimum 1 role extracted
✅ Education: Minimum 1 institution  
✅ Summary: Never empty
✅ Skills: Technical skills should not be empty if CV mentions technologies

**CRITICAL RULE:** Prefer LITERAL extraction over intelligent inference. Only infer when literal data is completely absent.

Return ONLY valid JSON. No explanations.
`.trim();

// --- Main Handler ---
/**
 * Vercel serverless function to process CV PDFs using Google Gemini AI
 * @param {VercelRequest} request - The incoming HTTP request
 * @param {VercelResponse} response - The outgoing HTTP response
 */
export default async function handler(request, response) {
  // Handle CORS preflight request
  if (CONFIG.CORS_ENABLED && request.method === 'OPTIONS') {
    CorsUtils.setHeaders(response, request.headers.origin);
    return response.status(200).end();
  }

  // Set CORS headers for main request
  if (CONFIG.CORS_ENABLED) {
    CorsUtils.setHeaders(response, request.headers.origin);
  }

  // Method validation
  if (request.method !== 'POST') {
    return response.status(405).json({
      message: 'Method not allowed',
      allowed: ['POST']
    });
  }

  // Input validation - Check request body exists
  if (!request.body) {
    return response.status(400).json({
      message: 'Request body is missing'
    });
  }

  // Destructure pdfBase64 *after* checking request.body exists
  const { pdfBase64 } = request.body;

  // Input validation
  if (!pdfBase64) {
    return response.status(400).json({
      message: 'Missing required field: pdfBase64'
    });
  }

  try {
    // --- Move API Key check and initialization inside the try block ---
    const API_KEY = process.env[CONFIG.API_KEY_NAME];
    if (!API_KEY) {
      throw new Error(`Missing ${CONFIG.API_KEY_NAME} environment variable`);
    }

    genAI = new GoogleGenerativeAI(API_KEY);
    model = genAI.getGenerativeModel({ model: CONFIG.MODEL_NAME });
    // --- End API Key check ---

    SecurityUtils.validateBase64(pdfBase64);

    // Log sanitized request metadata
    console.log(`[CV Process] Request received: ${Date.now()}`);

    // Prepare content for AI - CORRECTED inlineData structure
    const pdfDataPart = {
      inlineData: {
        data: pdfBase64, // FIXED: Explicitly use 'data' field name
        mimeType: "application/pdf"
      }
    };

    // Call AI with timeout protection
    const aiResult = await Promise.race([
      model.generateContent({
        contents: [{
          role: "user",
          parts: [pdfDataPart, { text: SYSTEM_PROMPT }]
        }],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI_REQUEST_TIMEOUT')), CONFIG.TIMEOUT_MS)
      )
    ]);

    const responseText = aiResult.response.text();

    // Debug logging (only in development)
    if (process.env.NODE_ENV === 'development') {
      console.log(`[CV Process] AI response length: ${responseText.length} chars`);
    }

    // Extract and parse JSON
    const jsonString = SecurityUtils.extractJson(responseText);
    const parsedData = JSON.parse(jsonString);

    // Validate response structure
    if (!parsedData || typeof parsedData !== 'object') {
      throw new Error("AI response is not a valid object");
    }
    if (!parsedData.cvData || !parsedData.jobData) {
      throw new Error("AI response missing required fields: cvData or jobData");
    }

    // Success response
    return response.status(200).json(parsedData);

  } catch (error) {
    // Log error details (safely, no stack traces)
    console.error('[CV Process] Error:', {
      message: error.message,
      type: error.constructor.name,
      timestamp: new Date().toISOString()
    });

    // Determine user-friendly message
    let userMessage = "Unable to process CV. An unexpected error occurred.";
    if (error.message === 'AI_REQUEST_TIMEOUT') {
      userMessage = `Request timed out after ${CONFIG.TIMEOUT_MS}ms. Try a smaller PDF.`;
    } else if (error.message.includes('AI response')) {
      userMessage = "AI service returned invalid data format.";
    } else if (error.message.includes('API key') || error.message.includes('configuration')) {
      userMessage = "Service configuration error. Please contact administrator.";
    }

    // Return error response - this is the only return for errors now
    return response.status(error.message === 'AI_REQUEST_TIMEOUT' ? 504 : 500)
                  .json({ message: userMessage });
  }
}