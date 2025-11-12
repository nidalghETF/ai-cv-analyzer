// api/processCV.js
import { GoogleGenerativeAI } from "@google/generative-ai";

// Get your HF token from environment variables (set in Vercel dashboard)
const API_KEY = process.env.GOOGLE_AI_API_KEY;
if (!API_KEY) {
  console.error("Missing GOOGLE_AI_API_KEY environment variable");
  // Do not throw here, let the handler return a 500
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Simple size check (base64 size ≈ 1.37x original)
function isBase64SizeValid(base64Str, maxMB) {
  const maxSize = maxMB * 1024 * 1024;
  // Rough estimate: decoded size is base64 length * 0.75
  const estimatedSize = (base64Str.length * 0.75);
  return estimatedSize <= maxSize;
}

export default async function handler(request, response) {
  // --- CORS Handling for Same-Origin ---
  // Assuming frontend uses relative path, origin should be the same.
  // Still, set headers for potential future flexibility or if proxying occurs.
  response.setHeader('Access-Control-Allow-Origin', '*'); // Or specific origin if needed
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  // --- End CORS ---

  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Method not allowed' });
  }

  if (!API_KEY) {
    return response.status(500).json({ message: 'Server configuration error: Missing API key.' });
  }

  const { pdfBase64 } = request.body;

  if (!pdfBase64) {
    return response.status(400).json({ message: 'Missing pdfBase64 in request body' });
  }

  // Basic validation
  if (typeof pdfBase64 !== 'string' || pdfBase64.length === 0) {
    return response.status(400).json({ message: 'Invalid pdfBase64: must be a non-empty string' });
  }

  // Size check (2MB limit as per frontend requirement)
  if (!isBase64SizeValid(pdfBase64, 2)) {
     return response.status(400).json({ message: 'PDF size exceeds 2MB limit.' });
  }

  // Basic format check (optional but good practice)
  if (!/^[A-Za-z0-9+/=]*$/.test(pdfBase64.replace(/\s/g, ''))) {
    return response.status(400).json({ message: 'Invalid pdfBase64: contains non-base64 characters' });
  }

  try {
    // Prepare content for AI
    // Note: Gemini expects the data part without the 'application/pdf;base64,' prefix
    // The frontend should send just the base64 string.
    const pdfDataPart = {
      inlineData: {
         pdfBase64, // Send the raw base64 string
        mimeType: "application/pdf"
      }
    };

    const prompt = `
        Analyze the provided CV PDF and extract the following information in a structured JSON format.
        The JSON should contain two main objects: "cvData" and "jobData".

        "cvData" should follow the CV template structure (Personal Info, Experience, Education, etc.).
        "jobData" should follow the Job Questionnaire template (Job Title, Requirements, etc.), inferring suitable roles and requirements based on the candidate's qualifications.

        Ensure the output is valid JSON only, with no additional text or explanations.
        If a field cannot be determined from the CV, use null or an empty string ("").

        Example structure (only as a guide for the AI, not sent by the frontend):
        {
          "cvData": {
            "personalInfo": {
              "fullName": "...",
              "professionalTitle": "...",
              "phoneNumber": "...",
              "emailAddress": "...",
              "location": "...",
              "linkedinProfile": "...",
              "portfolioWebsite": "...",
              "professionalSummary": "..."
            },
            "coreCompetencies": {
              "technicalSkills": "...",
              "softSkills": "..."
            },
            "certifications": [
              { "name": "...", "issuingOrganization": "...", "date": "YYYY-MM-DD" }
            ],
            "languages": [
              { "name": "...", "proficiency": "..." }
            ],
            "experience": [
              {
                "jobTitle": "...",
                "companyName": "...",
                "employmentDates": "...",
                "location": "...",
                "keyResponsibilities": "...",
                "keyAchievements": "..."
              }
            ],
            "education": [
              {
                "degree": "...",
                "institutionName": "...",
                "completionDate": "...",
                "location": "..."
              }
            ],
            "additionalInfo": {
              "projects": "...",
              "publications": "...",
              "professionalMemberships": "...",
              "volunteerExperience": "..."
            }
          },
          "jobData": {
            "jobIdentification": {
              "jobTitle": "...",
              "referenceId": "...",
              "companyDetails": {
                 "name": "...",
                 "size": "...",
                 "industry": "..."
              },
              "employmentType": "...",
              "locationType": "..."
            },
            "positionDetails": {
              "jobDescription": "...",
              "applicationDeadline": "YYYY-MM-DD",
              "employmentType": "...",
              "locationType": "..."
            },
            "candidateRequirements": {
              "requiredEducation": { "level": "...", "fieldOfStudy": "..." },
              "experienceYears": ...,
              "requiredSkills": "...",
              "requiredCertifications": "...",
              "requiredLanguages": "..."
            },
            "preferredQualifications": {
              "preferredEducation": "...",
              "preferredExperience": "...",
              "preferredSkills": "...",
              "preferredCertifications": "..."
            },
            "compensationBenefits": {
              "salaryRange": "...",
              "bonus": "...",
              "insurance": "...",
              "retirement": "...",
              "pto": "...",
              "otherBenefits": "..."
            },
            "applicationProcess": {
              "deadline": "YYYY-MM-DD",
              "requiredDocuments": "...",
              "interviewProcess": "...",
              "contactPerson": "..."
            }
          }
        }
      `;

    const contents = [
      {
        role: "user",
        parts: [
          pdfDataPart,
          { text: prompt }
        ],
      },
    ];

    const result = await model.generateContent({
      contents, // Pass the structured content
    });

    const responseText = result.response.text();
    console.log("Raw AI Response (first 200 chars):", responseText.substring(0, 200)); // Log for debugging

    let parsedData;
    try {
      // Find the JSON part in the response (sometimes AI might add text before/after)
      const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```|```([\s\S]*?)```|([\s\S]+)/);
      const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[2] || jsonMatch[3]).trim() : responseText.trim();

      if (!jsonString) {
        throw new Error("AI response did not contain any text that looks like JSON.");
      }

      // Remove potential control characters
      const cleanJsonString = jsonString.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
      parsedData = JSON.parse(cleanJsonString);
    } catch (parseError) {
      console.error("Error parsing AI response as JSON:", parseError);
      console.error("Raw response was:", responseText);
      return response.status(502).json({ message: "AI service returned invalid data format." });
    }

    if (!parsedData.cvData || !parsedData.jobData) {
      return response.status(502).json({ message: "AI service returned incomplete data." });
    }

    response.status(200).json(parsedData);
  } catch (error) {
    console.error("Error during AI processing:", error);
    // Send a generic error message to the frontend for security
    response.status(500).json({ message: "Error processing the CV with the AI service." });
  }
}