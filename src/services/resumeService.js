import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { getGeminiModel } from '../config/gemini.js';
import { SYSTEM_PROMPT } from '../prompts/resumePrompt.js';

export async function extractTextFromFile(file) {
  const buffer = await file.toBuffer();
  const filename = file.filename || '';
  const lower = filename.toLowerCase();

  if (lower.endsWith('.pdf')) {
    const data = await pdfParse(buffer);
    return data.text || '';
  }

  if (lower.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }

  return '';
}

export async function evaluateResume(resumeText) {
  const model = getGeminiModel();

  const prompt = `
${SYSTEM_PROMPT}

Currículo:
---
${resumeText}
---`;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();

  // O prompt já instrui a retornar apenas JSON; aqui garantimos isso no backend
  try {
    return JSON.parse(text);
  } catch {
    // fallback: tenta limpar possíveis ```json ``` ou textos extras
    const cleaned = text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      return {
        overallScore: 0,
        summary: 'Não foi possível interpretar a resposta do modelo como JSON.',
        sections: [],
        raw: text,
      };
    }
  }
}

