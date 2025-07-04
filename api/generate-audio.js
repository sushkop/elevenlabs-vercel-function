// /api/generate-audio.js

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import Airtable from "airtable";
import fetch from "node-fetch";

// --- Initialize API Clients ---
// These clients are configured using environment variables, which you'll set in Vercel.
const s3Client = new S3Client({
  region: process.env.AWS_S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
)(process.env.AIRTABLE_TABLE_NAME);


// --- The Main Serverless Function Handler ---
export default async function handler(req, res) {
  // 1. We only accept POST requests to this endpoint
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed. Use POST." });
  }

  // 2. Get the Airtable Record ID from the request body
  const { recordId } = req.body;
  if (!recordId) {
    return res.status(400).json({ message: "Missing required field: recordId" });
  }

  console.log(`Processing request for Airtable Record ID: ${recordId}`);

  try {
    // --- Step 1: Fetch Script from Airtable ---
    const record = await airtable.find(recordId);
    const scriptText = record.get("Script"); // Assumes your text field is named "Script"

    if (!scriptText) {
      throw new Error("Script field is empty or not found in Airtable record.");
    }
    console.log("Successfully fetched script from Airtable.");


    // --- Step 2: Call ElevenLabs API for TTS with Timestamps ---
    const elevenLabsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}/stream?output_format=mp3_44100_128_timestamps`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          model_id: "eleven_multilingual_v2", // Or another model you prefer
          text: scriptText,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!elevenLabsResponse.ok) {
        const errorBody = await elevenLabsResponse.text();
        throw new Error(`ElevenLabs API Error: ${elevenLabsResponse.status} ${errorBody}`);
    }

    console.log("Streaming response from ElevenLabs...");

    // --- Step 3: Process the Streaming Response ---
    // The stream contains audio chunks mixed with JSON objects for timestamps.
    // We need to separate them.
    const audioChunks = [];
    const timestamps = [];
    
    // We use a special function to iterate through the stream
    for await (const chunk of elevenLabsResponse.body) {
      // A small try-catch block helps separate JSON from audio data
      try {
        const timestampData = JSON.parse(chunk.toString());
        timestamps.push(timestampData);
      } catch (error) {
        // If JSON.parse fails, it's an audio chunk.
        audioChunks.push(chunk);
      }
    }
    
    console.log("Stream processing complete. Found", timestamps.length, "timestamp objects.");

    // Combine all audio chunks into a single buffer
    const audioBuffer = Buffer.concat(audioChunks);


    // --- Step 4: Upload the Audio to Amazon S3 ---
    const fileName = `audio/${recordId}-${Date.now()}.mp3`;
    
    const s3Command = new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: fileName,
        Body: audioBuffer,
        ContentType: 'audio/mpeg',
    });

    await s3Client.send(s3Command);
    console.log(`Successfully uploaded audio to S3: ${fileName}`);

    // Construct the public URL for the file
    const audioUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileName}`;


    // --- Step 5: Update Airtable with Audio URL and Timestamps ---
    await airtable.update(recordId, {
      "Audio URL": audioUrl,
      "Timestamps JSON": JSON.stringify(timestamps, null, 2), // Pretty-print the JSON
    });
    console.log("Successfully updated Airtable record.");


    // --- Step 6: Send Final Response ---
    res.status(200).json({
      message: "Successfully generated audio and updated records.",
      audioUrl: audioUrl,
      recordId: recordId,
    });

  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "An internal error occurred.", error: error.message });
  }
}