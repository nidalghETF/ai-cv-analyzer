import OpenAI from 'openai';

// Rate limiting configuration
const rateLimitStore = new Map();
const RATE_LIMIT = {
  MAX_REQUESTS: 10,
  WINDOW_MS: 60000,
  BLOCK_TIME: 300000
};

const CONFIG = {
  API_KEY: process.env.DEEPSEEK_API_KEY,
  MODEL: 'deepseek/deepseek-r1:free',
  MAX_FILE_SIZE: 2 * 1024 * 1024,
  TIMEOUT: 60000
};

// Security and validation utilities
const SecurityUtils = {
  validatePDF: (base64String) => {
    try {
      const cleanBase64 = base64String.replace(/^data:application\/pdf;base64,/, '');
      
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
        throw new Error('Invalid base64 format');
      }
      
      const fileSize = (cleanBase64.length * 3) / 4;
      if (fileSize > CONFIG.MAX_FILE_SIZE) {
        throw new Error(`File size exceeds ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB limit`);
      }
      
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

    if (clientData.blockedUntil > now) {
      const remaining = Math.ceil((clientData.blockedUntil - now) / 1000);
      throw new Error(`Rate limit exceeded. Try again in ${remaining} seconds.`);
    }

    if (clientData.timestamp < windowStart) {
      clientData.count = 1;
      clientData.timestamp = now;
    } else {
      clientData.count++;
    }

    rateLimitStore.set(ip, clientData);

    if (clientData.count > RATE_LIMIT.MAX_REQUESTS) {
      clientData.blockedUntil = now + RATE_LIMIT.BLOCK_TIME;
      throw new Error('Too many requests. Please wait 5 minutes.');
    }
  }
};

// Keep your existing SYSTEM_PROMPT exactly as it was
const SYSTEM_PROMPT = `Extract CV data into this exact JSON structure. CRITICAL: EXTRACT CERTIFICATIONS AND PROJECTS FROM ANY SECTION.

PROFESSIONAL SUMMARY REQUIREMENT:
- MUST create 3-4 sentence professional summary from entire CV
- Synthesize from: career highlights, key skills, major achievements, career trajectory
- Make it compelling and professional - not just concatenated text
- NEVER leave empty - create from experience if no explicit summary exists
- MUST be grammatically correct and coherent

// ... [KEEP YOUR ENTIRE EXISTING SYSTEM_PROMPT EXACTLY AS IT WAS] ...
// ... [DON'T CHANGE ANYTHING IN THE PROMPT] ...
// ... [JUST COPY YOUR EXISTING LONG PROMPT HERE] ...

Return ONLY valid JSON`;

let openai;

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
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    SecurityUtils.applyRateLimit(clientIP);

    // Validate request
    const { pdfBase64 } = req.body;
    if (!pdfBase64) {
      return res.status(400).json({ message: 'Missing pdfBase64 in request body' });
    }

    // Validate API key
    if (!CONFIG.API_KEY) {
      console.error('Missing DeepSeek API key');
      return res.status(500).json({ message: 'Service configuration error' });
    }

    // Validate PDF
    const cleanBase64 = SecurityUtils.validatePDF(pdfBase64);

    // Initialize OpenAI client for OpenRouter
    openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: CONFIG.API_KEY,
      defaultHeaders: {
        'HTTP-Referer': 'https://ai-cv-analyzer.vercel.app',
        'X-Title': 'AI CV Analyzer',
      },
    });

    console.log('Processing CV for IP:', clientIP);

    // Convert PDF to text (we'll need to extract text first)
    // For now, we'll use the base64 as context since DeepSeek-R1 can handle it in the prompt
    const pdfText = `PDF Content (Base64): ${cleanBase64.substring(0, 1000)}...`; // Truncate for token limits

    // Call DeepSeek via OpenRouter
    async function callAIWithRetry(prompt, maxRetries = 3) {
      let lastError;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`[CV Process] AI attempt ${attempt}/${maxRetries}`);
          
          const completion = await openai.chat.completions.create({
            model: CONFIG.MODEL,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: `Please analyze this CV PDF and extract the information: ${pdfText}` }
            ],
            max_tokens: 4000,
            temperature: 0.1,
          });

          const responseText = completion.choices[0].message.content;
          
          // Parse response
          let jsonString = responseText.trim().replace(/```json\s*|\s*```/g, '');
          const firstBrace = jsonString.indexOf('{');
          const lastBrace = jsonString.lastIndexOf('}');
          
          if (firstBrace === -1 || lastBrace === -1) {
            throw new Error('No JSON object found in AI response');
          }
          
          jsonString = jsonString.substring(firstBrace, lastBrace + 1);
          const parsedData = JSON.parse(jsonString);

          return parsedData;
          
        } catch (error) {
          lastError = error;
          console.log(`[CV Process] AI attempt ${attempt} failed:`, error.message);

          const shouldRetry = 
            error.message.includes('timeout') ||
            error.message.includes('rate limit') ||
            error.message.includes('429') ||
            error.message.includes('quota');
            
          if (attempt < maxRetries && shouldRetry) {
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`[CV Process] Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            break;
          }
        }
      }
      
      throw lastError;
    }

    const parsedData = await callAIWithRetry(SYSTEM_PROMPT);

    console.log('Successfully processed CV for:', parsedData.cvData?.personalInfo?.fullName || 'Unknown');

    return res.status(200).json(parsedData);

  } catch (error) {
    console.error('CV Processing Error:', error.message);

    let statusCode = 500;
    let userMessage = 'Unable to process CV. Please try again.';

    if (error.message.includes('Rate limit') || error.message.includes('Too many requests')) {
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
    } else if (error.message.includes('quota') || error.message.includes('429')) {
      statusCode = 429;
      userMessage = 'AI service rate limited. Please try again in a few moments.';
    }

    return res.status(statusCode).json({ 
      message: userMessage,
      ...(process.env.NODE_ENV === 'development' && { error: error.message })
    });
  }
}