// api/processCV.js
import { GoogleGenerativeAI } from "@google/generative-ai";

// Enhanced rate limiting with persistent storage simulation
const rateLimitStore = new Map();
const RATE_LIMIT_CONFIG = {
  MAX_REQUESTS_PER_MINUTE: 3, // Reduced for safety
  WINDOW_MS: 60000,
  MAX_RETRIES: 2,
  RETRY_DELAY_MS: 30000
};

const CONFIG = {
  API_KEY_NAME: "GOOGLE_AI_API_KEY", 
  MODEL_NAME: process.env.GEMINI_MODEL || "gemini-2.0-flash-exp",
  MAX_FILE_SIZE_MB: 2,
  TIMEOUT_MS: 45000 // Reduced timeout
};

// Enhanced security utilities
const SecurityUtils = {
  validatePDF: (base64String) => {
    try {
      const cleanBase64 = base64String.startsWith('data:application/pdf;base64,') 
        ? base64String.split(',')[1] 
        : base64String;
      
      // Validate base64 format
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
        throw new Error('Invalid base64 format');
      }
      
      const binaryString = atob(cleanBase64);
      
      // Check PDF magic number (%PDF)
      if (!binaryString.startsWith('%PDF')) {
        throw new Error('Invalid PDF file: Missing PDF header');
      }
      
      // Check for PDF structure
      if (binaryString.indexOf('%%EOF') === -1 && binaryString.indexOf('%%EOF\n') === -1) {
        throw new Error('Invalid PDF file: Missing EOF marker');
      }
      
      // Check file size
      const sizeInBytes = (cleanBase64.length * 3) / 4;
      const maxSize = CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024;
      
      if (sizeInBytes > maxSize) {
        throw new Error(`File too large. Maximum size is ${CONFIG.MAX_FILE_SIZE_MB}MB.`);
      }
      
      if (sizeInBytes === 0) {
        throw new Error('Empty PDF file');
      }
      
      return cleanBase64;
    } catch (error) {
      throw new Error(`PDF validation failed: ${error.message}`);
    }
  },
  
  applyRateLimit: (ip) => {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_CONFIG.WINDOW_MS;
    
    // Clean old entries
    for (const [key, data] of rateLimitStore.entries()) {
      if (data.timestamp < windowStart) {
        rateLimitStore.delete(key);
      }
    }
    
    const clientData = rateLimitStore.get(ip) || { 
      count: 0, 
      timestamp: now,
      blockedUntil: 0 
    };
    
    // Check if IP is temporarily blocked
    if (clientData.blockedUntil > now) {
      const remainingTime = Math.ceil((clientData.blockedUntil - now) / 1000);
      throw new Error(`Rate limit exceeded. Please try again in ${remainingTime} seconds.`);
    }
    
    if (clientData.timestamp < windowStart) {
      // Reset counter for new window
      clientData.count = 1;
      clientData.timestamp = now;
    } else {
      clientData.count++;
    }
    
    rateLimitStore.set(ip, clientData);
    
    if (clientData.count > RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_MINUTE) {
      // Block for 5 minutes
      clientData.blockedUntil = now + 300000;
      rateLimitStore.set(ip, clientData);
      throw new Error('Too many requests. Please wait 5 minutes before trying again.');
    }
  }
};

const SYSTEM_PROMPT = `Extract CV data into this exact JSON structure. CREATE PROFESSIONAL SUMMARY and DYNAMIC ARRAYS.

PROFESSIONAL SUMMARY REQUIREMENT:
- MUST create 3-4 sentence professional summary from entire CV
- Synthesize from: career highlights, key skills, major achievements, career trajectory
- Make it compelling and professional - not just concatenated text
- NEVER leave empty - create from experience if no explicit summary exists
- MUST be grammatically correct and coherent

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
      "summary": "CREATE COMPELLING PROFESSIONAL SUMMARY HERE"
    },
    "coreCompetencies": {
      "technicalSkills": "extract all technical skills/tools as comma list",
      "softSkills": "extract interpersonal/soft skills as comma list"
    },
    "certifications": [
      {"name": "cert name", "issuingOrganization": "issuer", "date": "YYYY-MM-DD"}
    ],
    "languages": [
      {"name": "language", "proficiency": "Native/Fluent/Intermediate/Basic"}
    ],
    "experience": [
      {
        "jobTitle": "position", 
        "companyName": "employer", 
        "employmentDates": "date range",
        "location": "city/state", 
        "jobDescription": "CREATE 2-3 sentence paragraph describing the role and overall responsibilities",
        "keyResponsibilities": "bullet points", 
        "keyAchievements": "quantified results"
      }
    ],
    "education": [
      {
        "degree": "degree name", 
        "institutionName": "school", 
        "completionDate": "graduation year", 
        "location": "city/state"
      }
    ],
    "additionalInfo": {
      "projects": "EXTRACT AS ARRAY OF PROJECT OBJECTS - NOT FLAT TEXT",
      "publications": "extract publications/research", 
      "professionalMemberships": "extract organizations",
      "volunteerExperience": "extract volunteer work"
    }
  },
  "jobData": {
    "jobIdentification": {
        "jobTitles": "EXTRACT 3-5 SPECIFIC JOB TITLES"
    },
    "companyInformation": {
        "industrySector": "EXTRACT RELEVANT INDUSTRIES"
    },
    "candidateRequirements": {
        "requiredEducationLevel": "DETERMINE EDUCATION REQUIREMENTS",
        "requiredFieldOfStudy": "IDENTIFY RELEVANT FIELDS", 
        "requiredYearsOfExperience": "CALCULATE EXPERIENCE RANGE",
        "requiredSkills": "EXTRACT ESSENTIAL SKILLS"
    }
  }
}

CRITICAL RULES:
- summary field MUST contain AI-generated professional summary
- projects should be structured objects, not flat text
- Fill ALL arrays with actual data from CV
- Return ONLY valid JSON`;

let genAI, model;

export default async function handler(request, response) {
  // Enhanced CORS with security headers
  const allowedOrigins = [
    'https://ai-cv-analyzer.vercel.app',
    'http://localhost:3000'
  ];
  
  const origin = request.headers.origin;
  if (allowedOrigins.includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    return response.status(403).json({ message: 'Origin not allowed' });
  }
  
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');

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

  // Validate content type
  const contentType = request.headers['content-type'];
  if (!contentType || !contentType.includes('application/json')) {
    return response.status(415).json({ message: 'Unsupported media type' });
  }

  try {
    // Enhanced rate limiting
    const clientIP = request.headers['x-forwarded-for'] || 
                    request.headers['x-real-ip'] || 
                    'unknown';
    SecurityUtils.applyRateLimit(clientIP);

    // Enhanced PDF validation
    const cleanBase64 = SecurityUtils.validatePDF(pdfBase64);

    const API_KEY = process.env[CONFIG.API_KEY_NAME];
    if (!API_KEY) {
      console.error('[SECURITY] Missing API key configuration');
      throw new Error('Service configuration error');
    }

    // Initialize AI model
    genAI = new GoogleGenerativeAI(API_KEY);
    model = genAI.getGenerativeModel({ 
      model: CONFIG.MODEL_NAME,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.1
      }
    });

    console.log('[CV Process] Request from IP:', clientIP);

    const pdfDataPart = {
      inlineData: {
        data: cleanBase64,
        mimeType: "application/pdf"
      }
    };

    // Enhanced timeout with retry logic
    let lastError;
    for (let attempt = 1; attempt <= RATE_LIMIT_CONFIG.MAX_RETRIES; attempt++) {
      try {
        const aiPromise = model.generateContent([
          { text: SYSTEM_PROMPT },
          pdfDataPart
        ]);

        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI processing timeout')), CONFIG.TIMEOUT_MS)
        );

        const aiResult = await Promise.race([aiPromise, timeoutPromise]);
        const responseText = aiResult.response.text();
        
        let jsonString = responseText.trim();
        jsonString = jsonString.replace(/```json\s*|\s*```/g, '');
        
        const firstBrace = jsonString.indexOf('{');
        const lastBrace = jsonString.lastIndexOf('}');
        
        if (firstBrace === -1 || lastBrace === -1) {
          throw new Error('No JSON object found in AI response');
        }
        
        jsonString = jsonString.substring(firstBrace, lastBrace + 1);
        const parsedData = JSON.parse(jsonString);

        // Enhanced quality validation
        function validateAIData(data) {
          const summary = data.cvData?.personalInfo?.summary || '';
          
          const garbagePatterns = [
            'is about at', 'is short at', 'Lantz', 'Lamis is short at',
            'undefined', 'null', '[object Object]', 'NaN', 'test', 'example'
          ];
          
          if (garbagePatterns.some(pattern => summary.includes(pattern))) {
            throw new Error('AI quality check failed - poor summary generated');
          }
          
          if (summary.length < 50 || summary.split('. ').length < 2) {
            throw new Error('AI quality check failed - summary too short');
          }
          
          // Validate required fields
          if (!data.cvData?.personalInfo?.fullName) {
            throw new Error('AI failed to extract basic information');
          }
          
          return true;
        }

        validateAIData(parsedData);

        console.log('[CV Process] Success for:', parsedData.cvData?.personalInfo?.fullName || 'Unknown');

        return response.status(200).json(parsedData);

      } catch (retryError) {
        lastError = retryError;
        if (attempt < RATE_LIMIT_CONFIG.MAX_RETRIES) {
          console.log(`[CV Process] Retry attempt ${attempt + 1} after error:`, retryError.message);
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_CONFIG.RETRY_DELAY_MS));
        }
      }
    }

    throw lastError;

  } catch (error) {
    console.error('[CV Process] Error:', error.message);
    
    let userMessage = "Unable to process CV. Please try again.";
    let statusCode = 500;
    
    if (error.message.includes('API key') || error.message.includes('Service configuration')) {
      userMessage = "Service configuration error.";
      statusCode = 500;
    } else if (error.message.includes('overloaded') || error.message.includes('429')) {
      userMessage = "AI service is busy. Please try again in 30 seconds.";
      statusCode = 503;
    } else if (error.message.includes('quality check failed')) {
      userMessage = "AI generated poor quality content. Please try again.";
      statusCode = 422;
    } else if (error.message.includes('Rate limit') || error.message.includes('Too many requests')) {
      userMessage = error.message;
      statusCode = 429;
    } else if (error.message.includes('Invalid PDF file') || error.message.includes('PDF validation')) {
      userMessage = error.message;
      statusCode = 400;
    } else if (error.message.includes('File too large')) {
      userMessage = error.message;
      statusCode = 400;
    } else if (error.message.includes('timeout')) {
      userMessage = "Processing took too long. Please try again.";
      statusCode = 408;
    } else if (error.message.includes('Origin not allowed')) {
      userMessage = "Access denied.";
      statusCode = 403;
    } else if (error.message.includes('Unsupported media type')) {
      userMessage = "Invalid request format.";
      statusCode = 415;
    }

    // Security: Don't expose internal errors in production
    const responseError = process.env.NODE_ENV === 'development' ? error.message : undefined;
    
    return response.status(statusCode).json({ 
      message: userMessage,
      ...(responseError && { error: responseError })
    });
  }
}