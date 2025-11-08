// api/processCV.js
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- Configuration ---
const CONFIG = {
  API_KEY_NAME: "GOOGLE_AI_API_KEY",
  MODEL_NAME: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  MAX_PDF_SIZE_MB: parseInt(process.env.MAX_PDF_SIZE_MB) || 5,
  TIMEOUT_MS: parseInt(process.env.AI_TIMEOUT_MS) || 60000,
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(o => o),
  CORS_ENABLED: process.env.CORS_ENABLED !== 'false'
};

// --- Core Initialization ---
const API_KEY = process.env[CONFIG.API_KEY_NAME];
if (!API_KEY) {
  console.error(`CRITICAL: Missing ${CONFIG.API_KEY_NAME} environment variable`);
  throw new Error("API key not configured. Check server logs.");
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: CONFIG.MODEL_NAME });

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
You are a professional CV analysis system. Extract structured data from the provided CV PDF and return ONLY a JSON object with two keys: "cvData" and "jobData".

**cvData**: Follow the CV template structure (Personal Info, Core Competencies, Certifications[], Languages[], Experience[], Education[], Additional Info). Use null or empty string for missing data.

**jobData**: Generate a matching job posting template based on the candidate's profile. Include Job Identification, Company Info, Position Details, Candidate Requirements, Preferred Qualifications, Location & Logistics, Compensation & Benefits, and Application Process.

CRITICAL RULES:
1. Return ONLY valid JSON. No explanations, markdown, or code fences.
2. Format dates as YYYY-MM-DD where possible.
3. Keep all text concise and professional.
4. Arrays must be returned as arrays, objects as objects.

Example reference structure: {"cvData":{"personalInfo":{"fullName":"..."}},"jobData":{"jobIdentification":{"jobTitle":"..."}}}
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

  const { pdfBase64 } = request.body;

  // Input validation
  if (!pdfBase64) {
    return response.status(400).json({ 
      message: 'Missing required field: pdfBase64' 
    });
  }

  try {
    SecurityUtils.validateBase64(pdfBase64);
  } catch (validationError) {
    console.warn('[CV Process] Validation failed:', validationError.message);
    return response.status(400).json({ message: validationError.message });
  }

  // Log sanitized request metadata
  console.log(`[CV Process] Request received: ${Date.now()}`);

  try {
    // Prepare content for AI
    const pdfDataPart = {
      inlineData: {
        data: pdfBase64,
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

    return response.status(error.message === 'AI_REQUEST_TIMEOUT' ? 504 : 500)
                  .json({ message: userMessage });
  }
}