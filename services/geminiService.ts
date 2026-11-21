import type { Person } from '../types';

export const analyzeFrameForSkeletons = async (
  base64ImageData: string,
  mimeType: string = 'image/jpeg',
): Promise<Person[]> => {
  const response = await fetch('/api/analyze-frame', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      imageBase64: base64ImageData,
      mimeType,
    }),
  });

  if (!response.ok) {
    let message = `Frame analysis failed (${response.status})`;
    try {
      const errBody = await response.json();
      if (errBody?.error) message = errBody.error;
    } catch {
      // ignore json parse errors
    }
    if (response.status === 429) {
      throw new Error('Rate limit exceeded');
    }
    throw new Error(message);
  }

  const data = (await response.json()) as { people?: Person[] };
  return Array.isArray(data.people) ? data.people : [];
};
