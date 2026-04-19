import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import OpenAI from "openai";

// Configure OpenAI client with user-provided details
const openai = new OpenAI({
  apiKey: "sk-6HHMbx5TiEUn6MBo82uWnyEnY5SNQI1zU7aRyNActQ7uWwHF",
  baseURL: "https://api.shyyf.vip/v1"
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware for parsing JSON requests
  app.use(express.json());

  // API routes FIRST
  app.post("/api/extractCities", async (req, res) => {
    try {
      const { prompt } = req.body;
      
      const completion = await openai.chat.completions.create({
        model: "gpt-5.4",
        messages: [
          {
            role: "system",
            content: `You are an intelligent global geographic knowledge assistant.
Task:
1. Identify all cities, countries, or regions worldwide mentioned or targeted by the user.
2. Provide their exact central latitude (lat) and longitude (lng) coordinates.
3. If the user asks a specific factual question, use your extensive knowledge to provide a concise, factual answer in Chinese in the 'info' field.
4. If no specific question is asked, leave 'info' empty, or provide a brief 1-sentence interesting fact in Chinese.
5. IMPORTANT: The 'name' field MUST be the standard Chinese translation of the location name.

You MUST respond ONLY with a raw JSON array of objects. Do not wrap in markdown \`\`\`json. Do not include any explanations.

Example Output:
[
  {
    "name": "福州",
    "lat": 26.0745,
    "lng": 119.2965,
    "info": "福州是福建省的省会，有悠久的建城历史和丰富的华侨资源。"
  }
]`
          },
          {
            role: "user",
            content: prompt
          }
        ],
        // Fallback to basic JSON type to prevent proxy crashes, or we just omit it if the custom proxy doesn't even support json_object.
        // Let's rely on prompt and parse gently since custom models can be unpredictable.
      });

      const responseText = completion.choices[0].message.content;
      if (!responseText) {
        return res.json([]);
      }
      
      const cleanText = responseText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      let parsedData;
      try {
        parsedData = JSON.parse(cleanText);
      } catch (e) {
        console.error("Failed to parse JSON:", cleanText);
        return res.json([]);
      }

      const cities = Array.isArray(parsedData) ? parsedData : (parsedData.cities && Array.isArray(parsedData.cities) ? parsedData.cities : [parsedData]);
      
      // Strictly validate that lat and lng are finite numbers before returning
      const validCities = cities.filter((c: any) => 
        c &&
        typeof c.name === 'string' &&
        typeof c.lat === 'number' && Number.isFinite(c.lat) &&
        typeof c.lng === 'number' && Number.isFinite(c.lng)
      );

      res.json(validCities);
    } catch (error) {
      console.error("API Error:", error);
      res.status(500).json({ error: "Failed to extract cities" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
