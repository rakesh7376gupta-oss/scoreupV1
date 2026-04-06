import { MongoClient } from "mongodb";

let cachedClient = null;
async function getCollection() {
  if (!cachedClient) {
    cachedClient = new MongoClient(process.env.MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db("scoreupai").collection("questions");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { question, subject, exam, image, imageType } = req.body;

  if (!question && !image) {
    return res.status(400).json({ error: "Question ya image dena zaroori hai!" });
  }

  // Cache check (only for text questions)
  if (question && !image) {
    try {
      const col = await getCollection();
      const cached = await col.findOne({ question: question.trim(), subject, exam });
      if (cached) return res.status(200).json({ answer: cached.answer, fromCache: true });
    } catch (e) { console.log("Cache check failed:", e.message); }
  }

  // Build the prompt
  const systemPrompt = `Tu ScoreUp.AI hai — India ke JEE, NEET, 11th aur 12th students ke liye expert AI teacher.

**ANSWER FORMAT — HAMESHA IS TARAH DO:**

## 📖 Chapter / Topic
[Konse chapter ka concept hai]

## 💡 Concept Samjho
[Simple Hinglish mein concept explain karo]

## 📐 Important Formulas
[Saari relevant formulas clearly likho — KaTeX format mein]
- Formula 1: $F = ma$
- Formula 2: ...

## 🔢 Step-by-Step Solution
**Step 1:** ...
**Step 2:** ...
**Step 3:** ...

## ✅ Final Answer
[Bold mein final answer]

## 🎯 Exam Tips
[JEE/NEET ke liye important trick ya shortcut]

---
**RULES:**
- Hinglish mein samjhao (Hindi + English mix)
- Math formulas KaTeX format mein likho ($...$)
- Har step clearly numbered hona chahiye
- Simple language, easy to understand
- Student ka exam: ${exam} | Subject: ${subject}`;

  try {
    // Call Gemini API
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const model = "gemini-2.5-flash";

    let contents;

    if (image) {
      // Vision mode — image + text
      contents = [{
        parts: [
          {
            inline_data: {
              mime_type: imageType || "image/jpeg",
              data: image
            }
          },
          {
            text: `${systemPrompt}\n\nQuestion: ${question || "Is image mein jo question/problem hai uska detailed solution do"}`
          }
        ]
      }];
    } else {
      // Text only mode
      contents = [{
        parts: [{ text: `${systemPrompt}\n\nQuestion: ${question}` }]
      }];
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents })
      }
    );

    if (!geminiRes.ok) {
      const errData = await geminiRes.json();
      throw new Error(errData.error?.message || "Gemini API error");
    }

    const geminiData = await geminiRes.json();
    const answer = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!answer) throw new Error("AI se koi answer nahi aaya");

    // Save to MongoDB
    try {
      const col = await getCollection();
      await col.insertOne({
        question: question?.trim() || "[Image Question]",
        answer,
        subject,
        exam,
        hasImage: !!image,
        createdAt: new Date()
      });
    } catch (e) { console.log("DB save failed:", e.message); }

    return res.status(200).json({ answer });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: "AI se answer nahi mila. Thodi der baad try karo: " + err.message });
  }
}
