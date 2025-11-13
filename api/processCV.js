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
CRITICAL: Extract EVERY field below. Use "N/A" only after exhaustive search. Infer intelligently where direct match isn't found.

**MANDATORY FIELD EXTRACTION RULES:**

## PERSONAL INFORMATION (SEARCH ALL VARIATIONS)
- "Full Name": Look in headers, contact info, top sections. Combine first/last if separate.
- "Professional Title": Current/most recent job title. If none, infer from experience.
- "Phone": Search for phone patterns (xxx-xxx-xxxx, (xxx) xxx-xxxx, international formats).
- "Email": Find email patterns (name@domain.com). Check all contact sections.
- "Location": City/State/Country from address, contact info, or experience locations.
- "LinkedIn": Extract full URLs from "LinkedIn", "Profile", "Contact" sections.
- "Portfolio": Find GitHub, personal website, Behance, etc. URLs.

## PROFESSIONAL SUMMARY (CRITICAL - NEVER EMPTY)
- Extract from: "Summary", "Profile", "Objective", "About", "Professional Profile", opening paragraph.
- If no explicit summary: Synthesize from experience highlights + key skills + career focus.
- Length: 3-5 sentences capturing career narrative and value proposition.

## CORE COMPETENCIES (EXHAUSTIVE SEARCH)
- "Technical Skills": Extract ALL from: "Skills", "Technical", "Technologies", "Tools", "Platforms", bullet lists, experience descriptions.
- "Soft Skills": Find in "Strengths", "Attributes", "Competencies", project descriptions, achievement context.
- FORMAT: Comma-separated. Group related technologies (e.g., "AWS: EC2, S3, Lambda").

## CERTIFICATIONS (DEEP SEARCH)
- Search: "Certifications", "Certificates", "Credentials", "Licenses", "Qualifications", training sections.
- Extract: Name, issuing organization, date (convert to YYYY-MM-DD).
- Include: Online courses (Coursera, Udemy), professional certs, licenses.

## LANGUAGES (WITH PROFICIENCY)
- Find in: "Languages", "Language Skills", "Bilingual", international experience context.
- Extract proficiency: "Native", "Fluent", "Professional", "Intermediate", "Basic".

## PROFESSIONAL EXPERIENCE (COMPREHENSIVE)
- Extract EVERY role in reverse chronological order.
- For each role: Job Title, Company, Dates (YYYY-MM-DD), Location, Responsibilities (bullet points), Achievements (quantified).
- Responsibilities: Daily tasks, key functions.
- Achievements: Metrics, impact, awards, promotions.

## EDUCATION (COMPLETE HISTORY)
- All degrees/certificates: Degree Type, Institution, Dates, Location.
- Include: University, College, Online degrees, Professional training.

## ADDITIONAL INFORMATION (THOROUGH)
- "Projects": Personal, academic, professional projects with descriptions.
- "Publications": Papers, articles, blog posts, conference presentations.
- "Professional Memberships": Organizations, associations, groups.
- "Volunteer Experience": Non-paid roles, community service, pro bono work.

## JOB DATA GENERATION (CONTEXTUAL)
- Base ALL job data on actual CV content - no generic templates.
- "jobTitle": Primary role matching current/most recent experience.
- "relatedTitles": Adjacent roles based on transferable skills.
- Infer company size, industry from candidate's experience pattern.

**EXTRACTION FAILSAFES:**
- If field not found explicitly, search for synonyms and related terms.
- If still not found, infer from context (e.g., location from company addresses).
- Only use "N/A" after exhaustive search and no contextual clues.

**OUTPUT VALIDATION:**
- Every cvData field MUST have a value (string, array, or "N/A").
- Arrays should not be empty without thorough search.
- Job data must logically connect to extracted CV content.

Return ONLY valid JSON matching this exact structure - no explanations.
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