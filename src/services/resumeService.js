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
    const finishReason = response?.candidates?.[0]?.finishReason;
    return { text: response.text(), finishReason };
  }

  let { text, finishReason } = await generateOnce(
    'IMPORTANTE: Retorne APENAS um JSON válido. Não inclua comentários, explicações, markdown ou texto extra.'
  );

  // O prompt já instrui a retornar apenas JSON; aqui garantimos isso no backend
  if (finishReason === 'MAX_TOKENS') {
    throw new Error(
      'A resposta do Gemini foi truncada (MAX_TOKENS). Aumente GEMINI_MAX_OUTPUT_TOKENS ou reduza o tamanho da resposta.'
    );
  }

  const direct = tryParseJson(text);
  if (direct.ok) return direct.value;

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
    throw new Error(
      'A resposta do Gemini parece truncada (JSON incompleto). Aumente GEMINI_MAX_OUTPUT_TOKENS ou reduza o tamanho da resposta.'
    );
  }

  const cleaned = stripCodeFences(text);
  const cleanedParsed = tryParseJson(cleaned);
  if (cleanedParsed.ok) return cleanedParsed.value;

  const extracted = extractJsonObject(cleaned);
  if (extracted) {
    const extractedParsed = tryParseJson(extracted);
    if (extractedParsed.ok) return extractedParsed.value;
  }

  if (GEMINI_JSON_RETRY) {
    const retryResult = await generateOnce(
      'Sua resposta anterior NÃO era um JSON válido. Refaça do zero e retorne APENAS um JSON válido (sem nenhum outro texto).'
    );
    const retryText = retryResult.text;

    if (retryResult.finishReason === 'MAX_TOKENS') {
      throw new Error(
        'A resposta do Gemini foi truncada (MAX_TOKENS). Aumente GEMINI_MAX_OUTPUT_TOKENS ou reduza o tamanho da resposta.'
      );
    }

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

export async function evaluateResumeFree(resumeText) {
  const model = getGeminiModel();

  const prompt = `
${SYSTEM_PROMPT}

IMPORTANTE: Você está gerando um preview gratuito.
- Retorne APENAS um JSON válido, sem texto extra.
- Retorne apenas 2 seções COMPLETAS (as 2 mais valiosas e impactantes para aumentar chances em ATS).
- Para as demais seções, retorne apenas metadados (title, score e tipCount), SEM listar as dicas.

A estrutura do JSON deve ser exatamente esta:
{
  "overallScore": <número de 0 a 100>,
  "summary": "<resumo geral em 2-3 frases (máx. 400 caracteres)>",
  "sections": [
    {
      "title": "<nome da seção>",
      "score": <número de 0 a 100>,
      "tips": [
        "<dica 1 (máx. 200 caracteres). Quando aplicável inclua 'Exemplo: ...'>",
        "<dica 2 (máx. 200 caracteres). Quando aplicável inclua 'Exemplo: ...'>",
        "<dica 3 (máx. 200 caracteres)>"
      ]
    }
  ],
  "lockedSections": [
    {
      "title": "<nome da seção>",
      "score": <número de 0 a 100>,
      "tipCount": <número inteiro de 2 a 3>
    }
  ]
}

Currículo:
---
${resumeText}
---`;

  async function generateOnce() {
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout do Gemini após ${GEMINI_TIMEOUT_MS}ms.`)), GEMINI_TIMEOUT_MS);
      }),
    ]);
    const response = await result.response;
    const finishReason = response?.candidates?.[0]?.finishReason;
    return { text: response.text(), finishReason };
  }

  const { text, finishReason } = await generateOnce();

  if (finishReason === 'MAX_TOKENS') {
    throw new Error(
      'A resposta do Gemini foi truncada (MAX_TOKENS). Aumente GEMINI_MAX_OUTPUT_TOKENS ou reduza o tamanho da resposta.'
    );
  }

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

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
    throw new Error(
      'A resposta do Gemini parece truncada (JSON incompleto). Aumente GEMINI_MAX_OUTPUT_TOKENS ou reduza o tamanho da resposta.'
    );
  }

  return {
    overallScore: 0,
    summary: 'Não foi possível interpretar a resposta do modelo como JSON.',
    sections: [],
    lockedSections: [],
    raw: text,
  };
}

