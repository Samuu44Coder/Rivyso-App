import { GoogleGenAI, Type } from "@google/genai";

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface StudyNotes {
  title: string;
  summary: string;
  keyPoints: string[];
  detailedContent: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
}

export interface StudyResponse {
  notes: StudyNotes;
  quiz: QuizQuestion[];
}

export type StudyMode = 'notes' | 'quiz' | 'both';

export interface ImageInput {
  base64: string;
  mimeType: string;
}

export async function processStudyImages(
  images: ImageInput[], 
  mode: StudyMode = 'both',
  referenceImages: ImageInput[] = []
): Promise<StudyResponse> {
  const model = "gemini-3-flash-preview";
  
  const prompt = `
    Analyze the uploaded ${images.length} image(s) of study material (primary content).
    ${mode === 'notes' || mode === 'both' ? '1. Extract and summarize the core information into concise study notes. Use clear Markdown formatting with descriptive headings (##, ###), bullet points, and bold text for important terms to ensure high readability.' : ''}
    ${mode === 'quiz' || mode === 'both' ? '2. Generate a practice quiz with 5-10 multiple-choice questions based on the primary content.' : ''}
    
    ${referenceImages.length > 0 ? `
    IMPORTANT: I have also provided ${referenceImages.length} "reference images" which contain past exams or quizzes. 
    Analyze the style, structure, level of difficulty, and phrasing used in these reference questions. 
    When generating the practice quiz, strictly mimic this specific style and format (e.g., how options are phrased, the types of distractors used, the complexity of technical terms).
    ` : ''}

    Ensure the output is high-quality for a student studying this material. Focus on clarity and logical structure.
    ${mode === 'notes' ? 'Provide dummy/empty quiz array if not requested.' : ''}
    ${mode === 'quiz' ? 'Provide dummy/empty notes object if not requested.' : ''}
    Provide the response in JSON format according to the specified schema.
  `;

  const primaryMaterialParts = images.map(img => ({
    inlineData: {
      mimeType: img.mimeType,
      data: img.base64,
    },
  }));

  const referenceStyleParts = referenceImages.map(img => ({
    inlineData: {
      mimeType: img.mimeType,
      data: img.base64,
    },
  }));

  const response = await genAI.models.generateContent({
    model,
    contents: {
      parts: [
        ...primaryMaterialParts,
        ...referenceStyleParts,
        { text: prompt },
      ],
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          notes: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              summary: { type: Type.STRING },
              keyPoints: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              detailedContent: { type: Type.STRING, description: "Extended explanation in Markdown" }
            },
            required: ["title", "summary", "keyPoints", "detailedContent"]
          },
          quiz: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                options: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                correctAnswer: { type: Type.STRING },
                explanation: { type: Type.STRING }
              },
              required: ["question", "options", "correctAnswer", "explanation"]
            }
          }
        },
        required: ["notes", "quiz"]
      }
    }
  });

  if (!response.text) {
    throw new Error("No response from system");
  }

  return JSON.parse(response.text);
}
