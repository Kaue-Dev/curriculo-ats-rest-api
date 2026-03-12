import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let geminiModel = null;

if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
}

export function getGeminiModel() {
  if (!geminiModel) {
    throw new Error('GEMINI_API_KEY não configurada no servidor.');
  }

  return geminiModel;
}

