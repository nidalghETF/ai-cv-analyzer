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
CRITICAL: You are a senior HR professional with 20+ years experience in talent acquisition and CV analysis.

**MISSION**: Extract deep career intelligence from this CV, don't just parse text.

**ANALYSIS APPROACH**:
- Understand career progression, skill evolution, and professional narrative
- Infer seniority level from responsibilities and achievements, not just job titles
- Identify transferable skills across industries and roles
- Recognize implicit competencies from project descriptions and achievements

**CV DATA EXTRACTION RULES**:
- "experience": Extract QUANTIFIABLE achievements (metrics, impact, scale) - not just responsibilities
- "coreCompetencies": Group related skills thematically (e.g., "Cloud Infrastructure: AWS, Azure, GCP")
- "education": Note honors, distinctions, relevant coursework if mentioned
- "certifications": Include expiration dates and issuing authorities when available
- For dates: Convert "Present" to current year-month, estimate durations if unclear

**JOB DATA GENERATION STRATEGY**:
- "jobTitle": Suggest 3-5 related roles based on skill transferability
- "careerLevel": Infer from team size managed, budget responsibility, strategic impact
- "estimatedRange": Research-based salary bands for industry/experience/location
- "suggestedEmployers": Companies where this profile would be competitive
- "essentialSkills": Must-haves for someone at this career stage
- "preferredQualifications": Nice-to-haves that would make candidate exceptional

**CONTEXT-AWARE INFERENCE GUIDELINES**:
- If CV shows leadership but no direct reports, infer "Team Leadership" or "Project Leadership"
- If multiple short roles, consider contract work or startup experience context
- If education > 10 years ago, emphasize experience over academic credentials
- For career changers, identify transferable skills and adjacent industries

**QUALITY CHECKS BEFORE OUTPUT**:
- Remove redundant information across sections
- Ensure chronological consistency in experience dates
- Validate that jobData realistically matches cvData seniority level
- Cross-check that inferred skills have supporting evidence in experience

Return ONLY valid JSON with "cvData" and "jobData" keys - no explanations, no markdown.

Example structure reference:
{
  "cvData": {
    "personalInfo": {"fullName": "...", "professionalTitle": "...", "email": "...", "phone": "...", "location": "...", "linkedIn": "...", "portfolio": "...", "summary": "..."},
    "coreCompetencies": {"technicalSkills": [], "softSkills": []},
    "certifications": [{"name": "...", "issuingOrganization": "...", "date": "..."}],
    "languages": [{"name": "...", "proficiency": "..."}],
    "experience": [{"jobTitle": "...", "company": "...", "dates": "...", "location": "...", "responsibilities": [], "achievements": []}],
    "education": [{"degree": "...", "institution": "...", "dates": "...", "location": "..."}],
    "additionalInfo": {"projects": "...", "publications": "...", "volunteer": "..."}
  },
  "jobData": {
    "jobIdentification": {"jobTitle": "...", "relatedTitles": [], "industrySectors": []},
    "companyInfo": {"suggestedEmployers": [], "companySizeRange": "...", "industryType": "..."},
    "positionDetails": {"summary": "...", "keyResponsibilities": [], "careerLevel": "..."},
    "candidateRequirements": {"essentialSkills": [], "technicalRequirements": [], "softSkills": []},
    "preferredQualifications": [],
    "locationAndLogistics": {"preferredRegions": [], "workSetting": "..."},
    "compensationAndBenefits": {"estimatedRange": "...", "benefits": []},
    "applicationProcess": {"recommendedNextSteps": "...", "idealHiringTimeline": "..."}
  }
}
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