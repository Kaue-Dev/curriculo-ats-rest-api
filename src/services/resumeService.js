import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { getGeminiModel } from '../config/gemini.js';
import { SYSTEM_PROMPT } from '../prompts/resumePrompt.js';

const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60000);
const GEMINI_JSON_RETRY = String(process.env.GEMINI_JSON_RETRY || '1') === '1';

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function stripCodeFences(text) {
  return text.replace(/```json/gi, '').replace(/```/g, '').trim();
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

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

  async function generateOnce(extraInstruction) {
    const fullPrompt = extraInstruction ? `${prompt}\n\n${extraInstruction}` : prompt;
    const result = await Promise.race([
      model.generateContent(fullPrompt),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout do Gemini após ${GEMINI_TIMEOUT_MS}ms.`)), GEMINI_TIMEOUT_MS);
      }),
    ]);
    const response = await result.response;
    return response.text();
  }

  let text = await generateOnce(
    'IMPORTANTE: Retorne APENAS um JSON válido. Não inclua comentários, explicações, markdown ou texto extra.'
  );

  // O prompt já instrui a retornar apenas JSON; aqui garantimos isso no backend
  const direct = tryParseJson(text);
  if (direct.ok) return direct.value;

  const cleaned = stripCodeFences(text);
  const cleanedParsed = tryParseJson(cleaned);
  if (cleanedParsed.ok) return cleanedParsed.value;

  const extracted = extractJsonObject(cleaned);
  if (extracted) {
    const extractedParsed = tryParseJson(extracted);
    if (extractedParsed.ok) return extractedParsed.value;
  }

  if (GEMINI_JSON_RETRY) {
    const retryText = await generateOnce(
      'Sua resposta anterior NÃO era um JSON válido. Refaça do zero e retorne APENAS um JSON válido (sem nenhum outro texto).'
    );

    const retryDirect = tryParseJson(retryText);
    if (retryDirect.ok) return retryDirect.value;

    const retryCleaned = stripCodeFences(retryText);
    const retryCleanedParsed = tryParseJson(retryCleaned);
    if (retryCleanedParsed.ok) return retryCleanedParsed.value;

    const retryExtracted = extractJsonObject(retryCleaned);
    if (retryExtracted) {
      const retryExtractedParsed = tryParseJson(retryExtracted);
      if (retryExtractedParsed.ok) return retryExtractedParsed.value;
    }

    text = retryText;
  }

  return {
    overallScore: 0,
    summary: 'Não foi possível interpretar a resposta do modelo como JSON.',
    sections: [],
    raw: text,
  };
}

