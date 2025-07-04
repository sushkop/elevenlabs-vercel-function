// /api/generate-audio.js

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import Airtable from "airtable";
import WebSocket from "ws"; // Import the new 'ws' package

// --- Initialize API Clients (No changes here) ---
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
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed. Use POST." });
  }

  const { recordId } = req.body;
  if (!recordId) {
    return res.status(400).json({ message: "Missing required field: recordId" });
  }
  
  console.log(`Processing request for Airtable Record ID: ${recordId}`);

  try {
    const record = await airtable.find(recordId);
    const scriptText = record.get("Script");
    if (!scriptText) {
      throw new Error("Script field is empty or not found in Airtable record.");
    }
    console.log("Successfully fetched script from Airtable.");
    
    // Use a Promise to handle the WebSocket asynchronous flow
    const { audioUrl, timestamps } = await generateAudioWithTimestamps(scriptText, recordId);

    // Update Airtable with the final data
    await airtable.update(recordId, {
      "Audio URL": audioUrl,
      "Timestamps JSON": JSON.stringify(timestamps, null, 2),
    });
    console.log("Successfully updated Airtable record.");
    
    res.status(200).json({
      message: "Successfully generated audio and updated records.",
      audioUrl: audioUrl,
      recordId: recordId,
    });

  } catch (error) {
    console.error("An error occurred in the handler:", error);
    res.status(500).json({ message: "An internal error occurred.", error: error.message });
  }
}

// --- New WebSocket-based Audio Generation Function ---
function generateAudioWithTimestamps(text, recordId) {
  // The WebSocket URL is different from the old one
const socketUrl = `wss://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream-input?model_id=eleven_monolingual_v1`;
  
  return new Promise((resolve, reject) => {
    const elevenlabsSocket = new WebSocket(socketUrl);
    const audioChunks = [];
    const timestamps = [];

    // 1. When the connection opens, send configuration
   elevenlabsSocket.on('open', () => {
  console.log('WebSocket connection opened. Waiting a moment...');
  // Add a small delay to ensure the connection is fully ready
  setTimeout(() => {
    console.log('Sending data to ElevenLabs...');
    
    // Send the "Beginning of Stream" (BOS) message with API key
    const bosMessage = {
      text: " ",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      xi_api_key: process.env.ELEVENLABS_API_KEY,
    };
    elevenlabsSocket.send(JSON.stringify(bosMessage));

    // Send the actual text message
    const textMessage = { text: text, try_trigger_generation: true };
    elevenlabsSocket.send(JSON.stringify(textMessage));

    // Send the "End of Stream" (EOS) message
    const eosMessage = { text: "" };
    elevenlabsSocket.send(JSON.stringify(eosMessage));
    
  }, 100); // 100 millisecond delay
});

    // 2. When a message is received, process it
    elevenlabsSocket.on('message', (message) => {
      const data = JSON.parse(message);
      
      // If the message contains an audio chunk, add it to our array
      if (data.audio_chunk) {
        audioChunks.push(Buffer.from(data.audio_chunk, 'base64'));
      }
      
      // If the message contains timestamp data, add it to our array
      if (data.alignment) {
        timestamps.push(data.alignment);
      }
    });

    // 3. Handle errors
    elevenlabsSocket.on('error', (error) => {
      console.error('WebSocket Error:', error);
      reject(error);
    });

    // 4. When the connection closes, process the final audio and resolve the promise
    elevenlabsSocket.on('close', async () => {
      console.log('WebSocket connection closed.');
      if (audioChunks.length === 0) {
        return reject(new Error("No audio data received from ElevenLabs."));
      }
      
      const audioBuffer = Buffer.concat(audioChunks);
      const fileName = `audio/${recordId}-${Date.now()}.mp3`;

      try {
        // Upload to S3
        const s3Command = new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: fileName,
            Body: audioBuffer,
            ContentType: 'audio/mpeg',
        });
        await s3Client.send(s3Command);
        console.log(`Successfully uploaded audio to S3: ${fileName}`);
        
        const audioUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${fileName}`;
        
        // Resolve with the final data
        resolve({ audioUrl, timestamps });

      } catch (error) {
        console.error("Error during S3 upload or Airtable update:", error);
        reject(error);
      }
    });
  });
}
