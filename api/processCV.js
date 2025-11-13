// api/processCV.js
import { GoogleGenerativeAI } from "@google/generative-ai";

const CONFIG = {
  API_KEY_NAME: "GOOGLE_AI_API_KEY",
  MODEL_NAME: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  MAX_PDF_SIZE_MB: 2,
  TIMEOUT_MS: 60000
};

const SYSTEM_PROMPT = `Extract CV data into this exact JSON structure. CREATE PROFESSIONAL SUMMARY and DYNAMIC ARRAYS.

**PROFESSIONAL SUMMARY REQUIREMENT:**
- MUST create 3-4 sentence professional summary from entire CV
- Synthesize from: career highlights, key skills, major achievements, career trajectory
- Make it compelling and professional - not just concatenated text
- NEVER leave empty - create from experience if no explicit summary exists

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
    "jobIdentification": {"jobTitle": "CREATE BASED ON EXPERIENCE"},
    "companyInfo": {"industryType": "inferred from background"},
    "positionDetails": {"summary": "CREATE JOB DESCRIPTION"},
    "candidateRequirements": {"essentialSkills": "from cv skills"},
    "compensationAndBenefits": {"estimatedRange": "industry standard"}
  }
}

**CRITICAL RULES:**
- "summary" field MUST contain AI-generated professional summary
- "projects" should be structured objects, not flat text
- Fill ALL arrays with actual data from CV
- Return ONLY valid JSON`;

let genAI, model;

const JsonUtils = {
  extractPureJson: (text) => {
    if (!text || typeof text !== 'string') {
      throw new Error('Empty or invalid AI response');
    }

    let jsonString = text.trim();
    
    jsonString = jsonString
      .replace(/^```json\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/^Here( is|'s) the JSON[:\s]*/i, '')
      .trim();

    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');
    
    if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
      console.error('JSON boundaries not found. Raw text:', text.substring(0, 200));
      throw new Error('No valid JSON object found in AI response');
    }

    jsonString = jsonString.substring(firstBrace, lastBrace + 1).trim();
    
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
      
      let repaired = jsonString
        .replace(/(\w+):/g, '"$1":')
        .replace(/,(\s*[}\]])/g, '$1')
        .replace(/'/g, '"')
        .replace(/(\s*:\s*)'([^']*)'/g, '$1"$2"')
        .replace(/:\s*(\w+)(\s*[,\}])/g, ':"$1"$2')
        .replace(/\n/g, ' ')
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

    const cleanBase64 = pdfBase64.startsWith('data:application/pdf;base64,') 
      ? pdfBase64.split(',')[1] 
      : pdfBase64;

    const pdfDataPart = {
      inlineData: {
        data: cleanBase64,
        mimeType: "application/pdf"
      }
    };

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

    const jsonString = JsonUtils.extractPureJson(responseText);
    const parsedData = JsonUtils.safeJsonParse(jsonString);

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