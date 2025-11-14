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

const SYSTEM_PROMPT = `Extract CV data into this exact JSON structure. CRITICAL: EXTRACT CERTIFICATIONS AND PROJECTS FROM ANY SECTION.

PROFESSIONAL SUMMARY REQUIREMENT:
- MUST create 3-4 sentence professional summary from entire CV
- Synthesize from: career highlights, key skills, major achievements, career trajectory
- Make it compelling and professional - not just concatenated text
- NEVER leave empty - create from experience if no explicit summary exists
- MUST be grammatically correct and coherent

CERTIFICATION EXTRACTION RULES:
- Extract ALL workshops, training programs, certifications regardless of section name
- Look for: "Workshop", "Training", "Certification", "Course", "Program", "Seminar"
- Include instructor names as issuingOrganization if no organization specified
- Search entire CV, not just "Certifications" section

PROJECT EXTRACTION RULES:
- Extract ALL projects: academic, personal, freelance, design portfolios, case studies
- Look beyond "Projects" section - check experience, education, and additional sections
- Include university projects, personal initiatives, design case studies, freelance work
- Even brief mentions in other sections should be extracted

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
      {
        "name": "EXTRACT certification/workshop name", 
        "issuingOrganization": "organization/instructor/company",
        "date": "YYYY-MM-DD if available"
      }
    ],
    "languages": [
      {
        "name": "language", 
        "proficiency": "Native/Fluent/Intermediate/Basic"
      }
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
      "projects": [
        {
          "title": "EXTRACT project title from anywhere in CV",
          "description": "project scope, objectives, and outcomes",
          "technologies": "tools/software/methods used",
          "dates": "project timeline if available",
          "url": "portfolio/github links if available"
        }
      ],
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

CERTIFICATION EXAMPLES:
- "From Nature to Art Installation of Bioconstruction" → {"name": "From Nature to Art Installation of Bioconstruction", "issuingOrganization": "Asli Tekin", "date": "2023-02-01"}
- "Save the Planet Design for Circular Economy" → {"name": "Save the Planet Design for Circular Economy", "issuingOrganization": "Marco Guama", "date": "2023-10-01"}
- Any workshop, training, or certification mentioned anywhere in CV

PROJECT EXAMPLES:
- University design projects mentioned in education section
- Personal projects mentioned in experience or additional sections  
- Portfolio pieces or case studies
- Freelance work or academic assignments

JOB DATA GENERATION RULES:
- jobTitles: Generate 3-5 ACTUAL job titles separated by commas based on CV experience
- industrySector: Suggest 2-3 ACTUAL industries that match the career background  
- requiredEducationLevel: Determine the ACTUAL minimum education required for these roles
- requiredFieldOfStudy: Suggest 2-3 ACTUAL relevant academic fields
- requiredYearsOfExperience: Calculate ACTUAL experience range like "3-5 years" or "5-8 years"
- requiredSkills: Extract ACTUAL essential skills from the CV competencies

DATA QUALITY RULES:
- professionalSummary: MUST be complete, coherent sentences. NO incomplete thoughts or gibberish.
- experience.dates: MUST be in employmentDates field ONLY
- experience.location: MUST be in location field ONLY  
- experience.keyResponsibilities: MUST be actual bullet points from CV, NOT field labels
- ALL text: MUST be grammatically correct and complete sentences
- education: Extract as structured objects, NOT markdown tables
- projects: MUST extract actual project data if present in CV
- certifications: MUST extract ALL certifications/workshops from entire CV

REJECTION CRITERIA:
- If any field contains incomplete sentences or gibberish, REGENERATE
- If dates appear in wrong fields, CORRECT THE MAPPING
- If bullet points contain field labels instead of actual content, FIX IT
- If certifications section is empty but CV mentions workshops/training, SEARCH AGAIN
- If projects section is empty but CV mentions project work, SEARCH AGAIN

EXAMPLE OUTPUT:
{
  "cvData": {
    "personalInfo": {
      "fullName": "Lamis Gharzeddine",
      "professionalTitle": "Design Intern",
      "phone": "+39 3347569416",
      "email": "lamis.gharzeddine@gmail.com",
      "location": "Rome, Italy",
      "linkedIn": "",
      "portfolio": "",
      "summary": "An enthusiastic and adaptable Design student pursuing a BA in Design with a strong academic record, complemented by practical internships in interior design and studio art. Lamis possesses a solid foundation in design software, including AutoCAD, Rhino, and Photoshop, and is adept at developing projects from concept to presentation. Her experience extends to sustainable design principles and client interaction, demonstrating a commitment to innovative and environmentally conscious solutions."
    },
    "coreCompetencies": {
      "technicalSkills": "Autocad, Rhino, Vray Rendering, 3DsMax, Dialux, Sketchup, Photoshop, InDesign",
      "softSkills": "Teamwork, Adaptability, Enthusiasm, Open-minded, Communication"
    },
    "certifications": [
      {"name": "From Nature to Art Installation of Bioconstruction", "issuingOrganization": "Asli Tekin", "date": "2023-02-01"},
      {"name": "Save the Planet Design for Circular Economy", "issuingOrganization": "Marco Guama", "date": "2023-10-01"}
    ],
    "languages": [
      {"name": "English", "proficiency": "Fluent"},
      {"name": "Spanish", "proficiency": "Intermediate"},
      {"name": "Italian", "proficiency": "Intermediate"}
    ],
    "experience": [
      {
        "jobTitle": "Interior Design Intern", 
        "companyName": "ām. Studio", 
        "employmentDates": "August 2025 - September 2025",
        "location": "Aley, Lebanon", 
        "jobDescription": "As an Interior Design Intern, Lamis was responsible for the end-to-end design process, from conceptualization to client presentation. This included developing detailed project designs using industry-standard software and effectively communicating design solutions for various clients.",
        "keyResponsibilities": "Developing project designs, Client presentations, Software utilization", 
        "keyAchievements": "Successfully contributed to client projects by designing interaction process and demonstrations"
      }
    ],
    "education": [
      {
        "degree": "BA Design", 
        "institutionName": "Rome University of Fine Arts", 
        "completionDate": "2026", 
        "location": "Rome, Italy"
      }
    ],
    "additionalInfo": {
      "projects": [
        {
          "title": "Garbage Patch State",
          "description": "Contributed to development and construction of artistic installation focusing on environmental awareness",
          "technologies": "Mixed media, Sustainable materials",
          "dates": "2023-2024",
          "url": ""
        }
      ],
      "publications": "", 
      "professionalMemberships": "",
      "volunteerExperience": ""
    }
  },
  "jobData": {
    "jobIdentification": {
        "jobTitles": "Junior Interior Designer, Design Assistant, CAD Technician, Sustainable Design Intern, Exhibit Designer"
    },
    "companyInformation": {
        "industrySector": "Architecture & Design, Interior Design, Sustainable Design, Art & Exhibitions"
    },
    "candidateRequirements": {
        "requiredEducationLevel": "Bachelor's Degree",
        "requiredFieldOfStudy": "Design, Interior Design, Architecture, Fine Arts", 
        "requiredYearsOfExperience": "0-2 years",
        "requiredSkills": "AutoCAD, Rhino, 3DsMax, Sketchup, Photoshop, InDesign, Project Development, Client Presentations, Teamwork, Sustainable Design Principles"
    }
  }
}

CRITICAL RULES:
- summary field MUST contain AI-generated professional summary
- projects should be structured objects, not flat text
- certifications MUST be extracted from entire CV, not just certifications section
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
    // Enhanced AI with retry only for network/timeout errors
    async function callAIWithRetry(prompt, pdfPart, maxRetries = 2) {
      let lastError;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`[CV Process] AI attempt ${attempt}/${maxRetries}`);
          
          const aiPromise = model.generateContent([prompt, pdfPart]);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('AI processing timeout')), CONFIG.TIMEOUT_MS)
          );

          const aiResult = await Promise.race([aiPromise, timeoutPromise]);
          const responseText = aiResult.response.text();
          
          // Parse response
          let jsonString = responseText.trim().replace(/```json\s*|\s*```/g, '');
          const firstBrace = jsonString.indexOf('{');
          const lastBrace = jsonString.lastIndexOf('}');
          
          if (firstBrace === -1 || lastBrace === -1) {
            throw new Error('No JSON object found in AI response');
          }
          
          jsonString = jsonString.substring(firstBrace, lastBrace + 1);
          const parsedData = JSON.parse(jsonString);

          // NO CONTENT VALIDATION - accept whatever AI returns
          return parsedData;
          
        } catch (error) {
          lastError = error;
          console.log(`[CV Process] AI attempt ${attempt} failed:`, error.message);

          // Only retry on network/timeout errors, not content issues
          const shouldRetry = 
            error.message.includes('timeout') ||
            error.message.includes('network') || 
            error.message.includes('fetch') ||
            error.message.includes('ECONNREFUSED') ||
            error.message.includes('ENOTFOUND');
            
          if (attempt < maxRetries && shouldRetry) {
            console.log('[CV Process] Retrying due to network issue...');
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            break;
          }
        }
      }
      
      throw lastError;
    }
    // Call AI with network-only retry logic
    const parsedData = await callAIWithRetry({ text: SYSTEM_PROMPT }, pdfDataPart);

    console.log('[CV Process] Success for:', parsedData.cvData?.personalInfo?.fullName || 'Unknown');

    return response.status(200).json(parsedData);
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