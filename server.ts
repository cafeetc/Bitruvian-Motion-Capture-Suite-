import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

const keypointSchema = {
  type: Type.OBJECT,
  properties: {
    x: { type: Type.NUMBER },
    y: { type: Type.NUMBER },
  },
  nullable: true,
};

const responseSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      keypoints: {
        type: Type.OBJECT,
        properties: {
          nose: keypointSchema,
          left_eye: keypointSchema,
          right_eye: keypointSchema,
          left_ear: keypointSchema,
          right_ear: keypointSchema,
          left_shoulder: keypointSchema,
          right_shoulder: keypointSchema,
          left_elbow: keypointSchema,
          right_elbow: keypointSchema,
          left_wrist: keypointSchema,
          right_wrist: keypointSchema,
          left_hip: keypointSchema,
          right_hip: keypointSchema,
          left_knee: keypointSchema,
          right_knee: keypointSchema,
          left_ankle: keypointSchema,
          right_ankle: keypointSchema,
        },
      },
    },
  },
};

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, model: 'gemini-4-hydrogen' });
  });

  app.post('/api/analyze-frame', async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body as {
        imageBase64?: string;
        mimeType?: string;
      };

      if (!imageBase64 || typeof imageBase64 !== 'string') {
        res.status(400).json({ error: 'Missing imageBase64 payload.' });
        return;
      }

      const safeMime =
        mimeType === 'image/png' || mimeType === 'image/webp' ? mimeType : 'image/jpeg';

      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            {
              text: [
                'Analyze the provided photo or video frame for motion capture pose estimation.',
                'Prioritize the single clearest, most prominent human figure first (even if the image is a tight headshot, close-up portrait, bust crop, or partial figure).',
                'For that subject (and any additional clearly visible figures), return normalized coordinates (x, y) between 0.0 and 1.0 for all visible keypoints among the 17 COCO landmarks (nose, left_eye, right_eye, left_ear, right_ear, left_shoulder, right_shoulder, left_elbow, right_elbow, left_wrist, right_wrist, left_hip, right_hip, left_knee, right_knee, left_ankle, right_ankle).',
                'Even on close-ups or portraits where lower-body parts are cropped out, detect every visible facial landmark (nose, eyes, ears) and upper-body landmark with high precision, and set any out-of-frame or occluded keypoints strictly to null.',
                'Be exact with anatomical left vs right sides of the subject.',
                'Return only a JSON array of objects, ordered with the clearest primary figure first.',
              ].join(' '),
            },
            {
              inlineData: {
                mimeType: safeMime,
                data: imageBase64,
              },
            },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema,
        },
      });

      const jsonText = (response.text ?? '[]').trim();
      const parsed = JSON.parse(jsonText);
      const people = Array.isArray(parsed) ? parsed : [];
      res.json({ people });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Error in /api/analyze-frame:', message);

      if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
        res.status(429).json({ error: 'Rate limit exceeded. Please wait briefly before retrying.' });
        return;
      }
      if (message.includes('403') || message.includes('PERMISSION_DENIED') || message.includes('API_KEY_INVALID')) {
        res.status(403).json({
          error: 'Gemini API key permission error. Check your API key in Settings > Secrets.',
        });
        return;
      }
      res.status(500).json({ error: message || 'Failed to analyze frame.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bitruvian Mocap server running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
