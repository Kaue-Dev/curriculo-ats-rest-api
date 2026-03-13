import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
const GEMINI_TEMPERATURE = Number(process.env.GEMINI_TEMPERATURE ?? 0.2);
const GEMINI_MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 2048);

let geminiModel = null;

if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel(
    {
      model: GEMINI_MODEL,
      generationConfig: {
        temperature: Number.isFinite(GEMINI_TEMPERATURE) ? GEMINI_TEMPERATURE : 0.2,
        maxOutputTokens: Number.isFinite(GEMINI_MAX_OUTPUT_TOKENS) ? GEMINI_MAX_OUTPUT_TOKENS : 2048,
        // Not in SDK typings, but accepted by the Gemini API; helps force JSON-only responses.
        responseMimeType: 'application/json',
      },
    },
    { apiVersion: GEMINI_API_VERSION }
  );

  // eslint-disable-next-line no-console
  console.log(`[gemini] model=${GEMINI_MODEL} apiVersion=${GEMINI_API_VERSION}`);
}

export function getGeminiModel() {
  if (!geminiModel) {
    throw new Error('GEMINI_API_KEY não configurada no servidor.');
  }

  return geminiModel;
}

