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
// api/processCV.js
import { GoogleGenerativeAI } from "@google/generative-ai";

const CONFIG = {
  API_KEY_NAME: "GOOGLE_AI_API_KEY",
  MODEL_NAME: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  MAX_PDF_SIZE_MB: 2,
  TIMEOUT_MS: 60000
};

// OPTIMIZED PROMPT - BALANCES INTELLIGENCE & RELIABILITY
const SYSTEM_PROMPT = `Extract CV data into this exact JSON structure:

{
  "cvData": {
    "personalInfo": {
      "fullName": "extract from header/contact",
      "professionalTitle": "current job title", 
      "phone": "find phone patterns",
      "email": "find email patterns",
      "location": "city/state from address",
      "linkedIn": "linkedin url if present",
      "portfolio": "portfolio/github url if present",
      "summary": "extract from summary/profile sections"
    },
    "coreCompetencies": {
      "technicalSkills": "extract all technical skills/tools",
      "softSkills": "extract interpersonal/soft skills"
    },
    "certifications": [],
    "languages": [],
    "experience": [],
    "education": [],
    "additionalInfo": {
      "projects": "",
      "publications": "", 
      "professionalMemberships": "",
      "volunteerExperience": ""
    }
  },
  "jobData": {
    "jobIdentification": {"jobTitle": "based on experience"},
    "companyInfo": {"industryType": "inferred from background"},
    "positionDetails": {"summary": "role description"},
    "candidateRequirements": {"essentialSkills": "from cv skills"},
    "compensationAndBenefits": {"estimatedRange": "industry standard"}
  }
}

CRITICAL: Return ONLY valid JSON. No explanations, no markdown, no other text.`;

let genAI, model;

// BULLETPROOF JSON EXTRACTION UTILITY
const JsonUtils = {
  extractPureJson: (text) => {
    if (!text || typeof text !== 'string') {
      throw new Error('Empty or invalid AI response');
    }

    let jsonString = text.trim();
    
    // Remove common AI artifacts
    jsonString = jsonString
      .replace(/^```json\s*/i, '')  // Remove opening ```json
      .replace(/\s*```$/i, '')      // Remove closing ```
      .replace(/^Here( is|'s) the JSON[:\s]*/i, '') // Remove introductory text
      .trim();

    // Find JSON object boundaries
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');
    
    if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
      console.error('JSON boundaries not found. Raw text:', text.substring(0, 200));
      throw new Error('No valid JSON object found in AI response');
    }

    // Extract pure JSON
    jsonString = jsonString.substring(firstBrace, lastBrace + 1).trim();
    
    // Validate basic JSON structure
    if (!jsonString.startsWith('{') || !jsonString.endsWith('}')) {
      throw new Error('Extracted text is not valid JSON');
    }

    return jsonString;
  },

  safeJsonParse: (jsonString) => {
    try {
      return JSON.parse(jsonString);
    } catch (initialError) {
      console.warn('Initial JSON parse failed, attempting repairs...');
      
      // Common AI JSON fixes
      let repaired = jsonString
        .replace(/(\w+):/g, '"$1":')                    // Add quotes to unquoted keys
        .replace(/,(\s*[}\]])/g, '$1')                  // Remove trailing commas
        .replace(/'/g, '"')                             // Replace single quotes with double
        .replace(/(\s*:\s*)'([^']*)'/g, '$1"$2"')       // Fix quoted values
        .replace(/:\s*(\w+)(\s*[,\}])/g, ':"$1"$2')     // Quote unquoted string values
        .replace(/\n/g, ' ')                            // Remove newlines
        .trim();

      try {
        return JSON.parse(repaired);
      } catch (repairError) {
        console.error('JSON repair failed. Original:', jsonString);
        console.error('Repaired:', repaired);
        throw new Error(`JSON parse failed: ${repairError.message}`);
      }
    }
  }
};

export default async function handler(request, response) {
  // CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Method not allowed' });
  }

  if (!request.body) {
    return response.status(400).json({ message: 'Request body is missing' });
  }

  const { pdfBase64 } = request.body;

  if (!pdfBase64) {
    return response.status(400).json({ message: 'Missing pdfBase64' });
  }

  try {
    const API_KEY = process.env[CONFIG.API_KEY_NAME];
    if (!API_KEY) {
      throw new Error('Missing API key configuration');
    }

    genAI = new GoogleGenerativeAI(API_KEY);
    model = genAI.getGenerativeModel({ model: CONFIG.MODEL_NAME });

    console.log('[CV Process] Request received');

    // Clean base64 data
    const cleanBase64 = pdfBase64.startsWith('data:application/pdf;base64,') 
      ? pdfBase64.split(',')[1] 
      : pdfBase64;

    const pdfDataPart = {
      inlineData: {
        data: cleanBase64,
        mimeType: "application/pdf"
      }
    };

    // AI API call with timeout
    const aiResult = await Promise.race([
      model.generateContent([
        { text: SYSTEM_PROMPT },
        pdfDataPart
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI request timeout')), CONFIG.TIMEOUT_MS)
      )
    ]);

    const responseText = aiResult.response.text();
    console.log('[CV Process] AI response length:', responseText.length);

    // BULLETPROOF JSON PROCESSING
    const jsonString = JsonUtils.extractPureJson(responseText);
    const parsedData = JsonUtils.safeJsonParse(jsonString);

    // Validate minimum structure
    if (!parsedData.cvData) {
      parsedData.cvData = {};
    }
    if (!parsedData.jobData) {
      parsedData.jobData = {};
    }

    console.log('[CV Process] Successfully parsed CV data');
    return response.status(200).json(parsedData);

  } catch (error) {
    console.error('[CV Process] Error:', {
      message: error.message,
      type: error.constructor.name,
      timestamp: new Date().toISOString()
    });

    // User-friendly error messages
    let userMessage = "Unable to process CV. Please try again.";
    if (error.message.includes('API key') || error.message.includes('configuration')) {
      userMessage = "Service configuration error. Please contact administrator.";
    } else if (error.message.includes('overloaded') || error.message.includes('503')) {
      userMessage = "AI service is temporarily busy. Please try again in 30 seconds.";
    } else if (error.message.includes('timeout')) {
      userMessage = "Request timed out. Please try a smaller PDF file.";
    } else if (error.message.includes('JSON')) {
      userMessage = "AI service returned invalid data format. Please try again.";
    }

    return response.status(500).json({ message: userMessage });
  }
}

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