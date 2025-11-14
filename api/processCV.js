import { GoogleGenerativeAI } from "@google/generative-ai";

// Rate limiting configuration
const rateLimitStore = new Map();
const RATE_LIMIT = {
  MAX_REQUESTS: 5,
  WINDOW_MS: 60000,
  BLOCK_TIME: 300000
};

const CONFIG = {
  API_KEY: process.env.GOOGLE_AI_API_KEY,
  MODEL: process.env.GEMINI_MODEL || "gemini-2.5-flash-exp",
  MAX_FILE_SIZE: 2 * 1024 * 1024, // 2MB
  TIMEOUT: 40000
};

// Security and validation utilities
const SecurityUtils = {
  validatePDF: (base64String) => {
    try {
      // Remove data URL prefix if present
      const cleanBase64 = base64String.replace(/^data:application\/pdf;base64,/, '');
      
      // Validate base64 format
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
        throw new Error('Invalid base64 format');
      }
      
      // Check file size
      const fileSize = (cleanBase64.length * 3) / 4;
      if (fileSize > CONFIG.MAX_FILE_SIZE) {
        throw new Error(`File size exceeds ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB limit`);
      }
      
      // Basic PDF validation
      const binary = atob(cleanBase64);
      if (!binary.includes('%PDF')) {
        throw new Error('Invalid PDF file: Missing PDF header');
      }
      
      return cleanBase64;
    } catch (error) {
      throw new Error(`PDF validation failed: ${error.message}`);
    }
  },

  applyRateLimit: (ip) => {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT.WINDOW_MS;

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

    // Check if blocked
    if (clientData.blockedUntil > now) {
      const remaining = Math.ceil((clientData.blockedUntil - now) / 1000);
      throw new Error(`Rate limit exceeded. Try again in ${remaining} seconds.`);
    }

    // Reset counter if window passed
    if (clientData.timestamp < windowStart) {
      clientData.count = 1;
      clientData.timestamp = now;
    } else {
      clientData.count++;
    }

    rateLimitStore.set(ip, clientData);

    // Block if over limit
    if (clientData.count > RATE_LIMIT.MAX_REQUESTS) {
      clientData.blockedUntil = now + RATE_LIMIT.BLOCK_TIME;
      throw new Error('Too many requests. Please wait 5 minutes.');
    }
  }
};

// Enhanced AI prompt for better extraction
const SYSTEM_PROMPT = `Extract and structure CV data into this exact JSON format. Follow these rules:

CRITICAL REQUIREMENTS:
1. Professional Summary: Create a compelling 3-4 sentence summary synthesizing the candidate's career highlights
2. Certifications: Extract ALL workshops, trainings, certifications from ANY section
3. Projects: Extract ALL projects (academic, personal, professional) from ANY section
4. Job Matching: Generate realistic job titles and requirements based on actual experience

OUTPUT FORMAT:
{
  "cvData": {
    "personalInfo": {
      "fullName": "extracted name",
      "professionalTitle": "current/most recent title",
      "phone": "phone number if present",
      "email": "email address",
      "location": "city, country",
      "linkedIn": "LinkedIn URL if present",
      "portfolio": "portfolio/github URL if present",
      "summary": "AI-GENERATED PROFESSIONAL SUMMARY"
    },
    "coreCompetencies": {
      "technicalSkills": "comma-separated technical skills",
      "softSkills": "comma-separated soft skills"
    },
    "certifications": [
      {
        "name": "certification/workshop name",
        "issuingOrganization": "issuing organization or instructor",
        "date": "YYYY-MM-DD if available"
      }
    ],
    "languages": [
      {
        "name": "language name",
        "proficiency": "Native/Fluent/Intermediate/Basic"
      }
    ],
    "experience": [
      {
        "jobTitle": "position title",
        "companyName": "company name",
        "employmentDates": "date range",
        "location": "work location",
        "jobDescription": "2-3 sentence role description",
        "keyResponsibilities": "key responsibilities",
        "keyAchievements": "quantifiable achievements"
      }
    ],
    "education": [
      {
        "degree": "degree name",
        "institutionName": "institution name",
        "completionDate": "graduation year",
        "location": "institution location"
      }
    ],
    "projects": [
      {
        "title": "project title",
        "description": "project description",
        "technologies": "technologies used",
        "dates": "project timeline",
        "url": "project URL if available"
      }
    ]
  },
  "jobData": {
    "jobIdentification": {
      "jobTitles": "3-5 relevant job titles based on experience"
    },
    "companyInformation": {
      "industrySector": "relevant industries"
    },
    "candidateRequirements": {
      "requiredEducationLevel": "required education level",
      "requiredFieldOfStudy": "relevant fields of study",
      "requiredYearsOfExperience": "years of experience range",
      "requiredSkills": "essential skills required"
    }
  }
}

DATA QUALITY RULES:
- Summary must be coherent, professional, and complete sentences
- Extract certifications from entire document, not just "Certifications" section
- Extract projects from entire document, not just "Projects" section
- All arrays should contain actual data found in the CV
- Job data should be realistic and based on the candidate's actual experience

Return ONLY valid JSON.`;

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Rate limiting
    const clientIP = req.ip || req.connection.remoteAddress;
    SecurityUtils.applyRateLimit(clientIP);

    // Validate request
    const { pdfBase64 } = req.body;
    if (!pdfBase64) {
      return res.status(400).json({ message: 'Missing pdfBase64 in request body' });
    }

    // Validate API key
    if (!CONFIG.API_KEY) {
      console.error('Missing Google AI API key');
      return res.status(500).json({ message: 'Service configuration error' });
    }

    // Validate PDF
    const cleanBase64 = SecurityUtils.validatePDF(pdfBase64);

    // Initialize AI
    const genAI = new GoogleGenerativeAI(CONFIG.API_KEY);
    const model = genAI.getGenerativeModel({
      model: CONFIG.MODEL,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.2
      }
    });

    console.log('Processing CV for IP:', clientIP);

    // Prepare PDF for AI
    const pdfPart = {
      inlineData: {
        data: cleanBase64,
        mimeType: "application/pdf"
      }
    };

    // Call AI with timeout
    const aiPromise = model.generateContent([{ text: SYSTEM_PROMPT }, pdfPart]);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('AI processing timeout')), CONFIG.TIMEOUT)
    );

    const result = await Promise.race([aiPromise, timeoutPromise]);
    const responseText = result.response.text();

    // Parse AI response
    let jsonString = responseText.trim();
    
    // Extract JSON from markdown code blocks if present
    const jsonMatch = jsonString.match(/```json\n?([\s\S]*?)\n?```/) || 
                     jsonString.match(/({[\s\S]*})/);
    
    if (jsonMatch) {
      jsonString = jsonMatch[1] || jsonMatch[0];
    }

    const parsedData = JSON.parse(jsonString);

    console.log('Successfully processed CV for:', parsedData.cvData?.personalInfo?.fullName || 'Unknown');

    return res.status(200).json(parsedData);

  } catch (error) {
    console.error('CV Processing Error:', error.message);

    let statusCode = 500;
    let userMessage = 'Unable to process CV. Please try again.';

    if (error.message.includes('Rate limit')) {
      statusCode = 429;
      userMessage = error.message;
    } else if (error.message.includes('PDF validation')) {
      statusCode = 400;
      userMessage = error.message;
    } else if (error.message.includes('timeout')) {
      statusCode = 408;
      userMessage = 'Processing took too long. Please try again.';
    } else if (error.message.includes('API key') || error.message.includes('configuration')) {
      statusCode = 500;
      userMessage = 'Service configuration error.';
    }

    return res.status(statusCode).json({ 
      message: userMessage,
      ...(process.env.NODE_ENV === 'development' && { error: error.message })
    });
  }
}