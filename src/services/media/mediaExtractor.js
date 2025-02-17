// mediaExtractor.js
import { logger } from "../../utils/logger.js";
import WhatsAppWeb from "whatsapp-web.js";
import axios from "axios";
import { MEDIA_PATTERNS } from "./mediaPatterns.js";
import {
  extractInstagramMedia,
  extractTikTokMedia,
  extractFacebookMedia,
  extractSoundCloudMedia,
} from "./extractors.js";
import Queue from "queue-promise";

const { MessageMedia } = WhatsAppWeb;
const PROCESSING_TIMEOUT = 60000; // 60 seconds
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB

// Processing queues to manage concurrent operations
const extractionQueue = new Queue({
  concurrent: 3,
  interval: 500
});

const downloadQueue = new Queue({
  concurrent: 5,
  interval: 500
});

const sendingQueue = new Queue({
  concurrent: 2,
  interval: 1000
});

// Configure axios instance
const axiosInstance = axios.create({
  timeout: 30000,
  maxRedirects: 10,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    Referer: "https://www.tiktok.com/",
    "Sec-Fetch-Dest": "video",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Ch-Ua": '"Google Chrome";v="113", "Chromium";v="113", "Not-A.Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
  },
  validateStatus: (status) => status >= 200 && status < 300,
  maxContentLength: 50 * 1024 * 1024, // 50MB max
  maxBodyLength: 50 * 1024 * 1024, // 50MB max
});

// Extract URLs from message
function extractUrl(messageBody) {
  if (!messageBody) return null;

  for (const [platform, pattern] of Object.entries(MEDIA_PATTERNS)) {
    const match = messageBody.match(pattern);
    if (match && match[0]) return match[0];
  }
  return null;
}

// Determine media type from URL
function getMediaType(url) {
  if (!url) return null;

  for (const [platform, pattern] of Object.entries(MEDIA_PATTERNS)) {
    if (pattern.test(url)) return platform.toLowerCase();
  }
  
  // Special case for akamaized.net URLs which are typically TikTok CDN URLs
  if (url.includes('akamaized.net') && url.includes('video/tos')) {
    return 'tiktok';
  }
  
  return null;
}

// Get specialized headers for specific domains
function getSpecializedHeaders(url) {
  const headers = { ...axiosInstance.defaults.headers };
  
  // TikTok CDN URLs
  if (url.includes('akamaized.net') || url.includes('tiktokcdn') || url.includes('tiktok.com')) {
    headers["Referer"] = "https://www.tiktok.com/";
    headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36";
  }
  
  // Instagram CDN URLs
  if (url.includes('cdninstagram.com') || url.includes('instagram.com')) {
    headers["Referer"] = "https://www.instagram.com/";
    headers["User-Agent"] = "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1";
  }
  
  return headers;
}

// Download media with retry mechanism
async function downloadMedia(url, retryCount = 3) {
  if (!url) throw new Error("Invalid media URL");

  let lastError;
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      // Get specialized headers for this URL
      const headers = getSpecializedHeaders(url);
      
      const response = await axiosInstance.get(url, {
        responseType: "arraybuffer",
        timeout: PROCESSING_TIMEOUT,
        headers,
        onDownloadProgress: (progressEvent) => {
          if (progressEvent.total && progressEvent.total > MAX_FILE_SIZE) {
            throw new Error(`File size exceeds maximum allowed (${MAX_FILE_SIZE / (1024 * 1024)}MB)`);
          }
        }
      });

      if (!response.data || response.data.length === 0) {
        throw new Error("Empty response received from server");
      }

      const buffer = Buffer.from(response.data);
      
      // Check file size after download
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`Downloaded file size (${buffer.length / (1024 * 1024)}MB) exceeds maximum allowed (${MAX_FILE_SIZE / (1024 * 1024)}MB)`);
      }
      
      // For debugging content types
      logger.debug(`Downloaded media content type: ${response.headers['content-type']} from URL: ${url.substring(0, 100)}...`);
      
      const base64 = buffer.toString("base64");
      const mimeType = response.headers["content-type"] || "application/octet-stream";

      return { base64, mimeType };
    } catch (error) {
      const errorDetails = error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers,
        data: error.response.data ? 
              (error.response.data instanceof Buffer ? 
               `Binary data of length ${error.response.data.length}` : 
               JSON.stringify(error.response.data).substring(0, 200))
              : 'No data'
      } : null;
      
      lastError = error;
      
      logger.error(`Download attempt ${attempt} failed for URL: ${url.substring(0, 100)}...`, {
        error: error.message,
        responseDetails: errorDetails
      });
      
      // Don't retry if it's a file size error
      if (error.message.includes("File size exceeds")) {
        throw error;
      }
      
      if (attempt < retryCount) {
        logger.warn(`Retrying download attempt ${attempt} for URL: ${url.substring(0, 100)}...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
      }
    }
  }
  
  throw lastError || new Error(`Failed to download media after ${retryCount} attempts`);
}

// Extract media URL based on platform
async function extractMediaUrl(url, mediaType) {
  if (!url || !mediaType) {
    throw new Error("Invalid URL or media type");
  }

  // If this is already a CDN URL, return it directly
  if (url.includes('akamaized.net') || url.includes('tiktokcdn.com')) {
    return { url };
  }

  const extractors = {
    instagram: extractInstagramMedia,
    tiktok: extractTikTokMedia,
    facebook: extractFacebookMedia,
    soundcloud: extractSoundCloudMedia,
  };

  const extractor = extractors[mediaType];
  if (!extractor) {
    throw new Error(`No extractor available for media type: ${mediaType}`);
  }

  return new Promise((resolve, reject) => {
    // Add to extraction queue
    extractionQueue.enqueue(async () => {
      try {
        const extractPromise = extractor(url);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Media extraction timed out for ${mediaType} URL: ${url}`)),
            PROCESSING_TIMEOUT,
          ),
        );

        // Wait for either the extraction or timeout
        const mediaData = await Promise.race([extractPromise, timeoutPromise]);

        if (mediaData.buffer) {
          // If the extractor returns a buffer, pass it as-is
          resolve(mediaData); // { buffer, mimeType }
        } else {
          // Otherwise, assume it's a URL
          resolve({ url: mediaData });
        }
      } catch (error) {
        logger.error(`Media extraction failed for ${mediaType} URL: ${url}`, error);
        reject(error);
      }
    });
  });
}

async function sendMedia(url, message) {
  if (!url || !message) return { success: false, reason: "Invalid URL or message" };

  try {
    const mediaType = getMediaType(url);
    if (!mediaType) return { success: false, reason: "Unsupported media type" };

    logger.info(`Processing ${mediaType} URL: ${url.substring(0, 100)}...`);
    
    // CDN URL handling - skip extraction if it's already a CDN URL
    let mediaData;
    if (url.includes('akamaized.net') || url.includes('tiktokcdn.com')) {
      mediaData = { url };
    } else {
      // Queue the extraction task 
      mediaData = await extractMediaUrl(url, mediaType);
    }

    logger.debug(`Extracted media data for ${mediaType}: ${JSON.stringify(
      typeof mediaData === 'object' ? 
        { ...mediaData, url: mediaData.url ? mediaData.url.substring(0, 100) + '...' : undefined } : 
        mediaData
    )}`);

    if (mediaType === "soundcloud" && mediaData.buffer) {
      // Validate buffer before sending
      if (Buffer.isBuffer(mediaData.buffer) && mediaData.buffer.length > 0) {
        if (mediaData.buffer.length > MAX_FILE_SIZE) {
          throw new Error(`SoundCloud audio size (${mediaData.buffer.length / (1024 * 1024)}MB) exceeds maximum allowed (${MAX_FILE_SIZE / (1024 * 1024)}MB)`);
        }
        
        const base64Buffer = mediaData.buffer.toString("base64");
        const media = new MessageMedia(mediaData.mimeType, base64Buffer);

        await sendingQueue.enqueue(async () => {
          try {
            await message.reply(media);
            logger.info(`Successfully sent SoundCloud audio for URL: ${url.substring(0, 100)}...`);
          } catch (error) {
            logger.error(`Failed to send SoundCloud media: ${error.message}`);
            throw error;
          }
        });
        
        return { success: true };
      } else {
        throw new Error("Invalid buffer returned from SoundCloud extractor");
      }
    }

    // For URL-based media, proceed as usual
    const mediaUrls = Array.isArray(mediaData.url)
      ? mediaData.url
      : [mediaData.url];

    // Check if we have too many media items
    if (mediaUrls.length > 5) {
      throw new Error(`Too many media items (${mediaUrls.length}). Maximum allowed is 5.`);
    }

    let successCount = 0;
    let lastError = null;

    for (const mediaUrl of mediaUrls) {
      try {
        // Queue the download task - FIX: Properly await and handle errors
        const mediaContent = await downloadQueue.enqueue(() => downloadMedia(mediaUrl));
        
        // FIX: Verify mediaContent is defined before destructuring
        if (!mediaContent) {
          throw new Error(`Failed to download media from URL: ${mediaUrl.substring(0, 100)}...`);
        }
        
        const { base64, mimeType } = mediaContent;
        logger.debug(
          `Downloaded media - URL: ${mediaUrl.substring(0, 100)}..., MIME type: ${mimeType}, size: ${base64.length} bytes`,
        );

        // Check file size after base64 encoding
        if (base64.length > MAX_FILE_SIZE * 1.37) { // Account for base64 encoding overhead
          throw new Error(`Encoded media size (${base64.length / (1024 * 1024)}MB) exceeds maximum allowed (${MAX_FILE_SIZE / (1024 * 1024)}MB)`);
        }

        const media = new MessageMedia(mimeType, base64);
        
        // Queue the sending task
        await sendingQueue.enqueue(async () => {
          try {
            await message.reply(media);
            logger.info(`Successfully sent media for URL: ${mediaUrl.substring(0, 100)}...`);
            successCount++;
          } catch (error) {
            logger.error(`Failed to send media for URL ${mediaUrl.substring(0, 100)}...: ${error.message}`);
            throw error;
          }
        });
      } catch (error) {
        logger.error(`Failed to process media URL ${mediaUrl.substring(0, 100)}...:`, error);
        lastError = error;
        // Continue with other URLs even if one fails
      }
    }

    // If at least one media was sent successfully, consider it a success
    if (successCount > 0) {
      return { success: true, partialSuccess: successCount < mediaUrls.length };
    } else {
      throw lastError || new Error("Failed to process all media items");
    }

  } catch (error) {
    logger.error("Error in processing media:", error);
    
    // Categorize errors for better handling
    if (error.message.includes("File size exceeds")) {
      return { 
        success: false, 
        reason: "File size limit exceeded", 
        details: error.message,
        shouldNotify: true  // Flag to indicate user should be notified
      };
    } else if (error.message.includes("timed out")) {
      return { 
        success: false, 
        reason: "Processing timed out", 
        details: error.message,
        shouldNotify: true
      };
    } else if (error.code === 'ECONNABORTED' || error.message.includes("timeout")) {
      return { 
        success: false, 
        reason: "Network timeout", 
        details: error.message,
        shouldNotify: true
      };
    } else if (error.response && error.response.status >= 400) {
      return { 
        success: false, 
        reason: `Server error (${error.response.status})`, 
        details: error.message,
        shouldNotify: true
      };
    }
    
    return { 
      success: false, 
      reason: "Processing error", 
      details: error.message,
      shouldNotify: error.shouldNotify || false
    };
  }
}

// Main handler for media extraction
export async function handleMediaExtraction(message) {
  if (!message?.body) return { processed: false };

  try {
    const url = extractUrl(message.body);
    if (!url) return { processed: false };

    const mediaType = getMediaType(url);
    if (!mediaType) return { processed: false };

    const chat = await message.getChat();
    await chat.sendStateTyping();

    const result = await sendMedia(url, message);

    // Handle user notification for specific errors
    if (!result.success && result.shouldNotify) {
      try {
        await message.reply(`Sorry, I couldn't process that media: ${result.reason}. ${result.details || ''}`);
      } catch (notifyError) {
        logger.error("Failed to send error notification:", notifyError);
      }
    }

    return {
      processed: result.success,
      mediaType,
      url,
      ...(!result.success && { error: result.reason, details: result.details }),
      ...(result.partialSuccess && { partialSuccess: true })
    };
  } catch (error) {
    logger.error("Error in handling media extraction:", error);
    
    try {
      // Attempt to notify user of the error
      await message.reply("Sorry, I couldn't process that media due to an unexpected error.");
    } catch (replyError) {
      logger.error("Failed to send error notification:", replyError);
    }
    
    return { 
      processed: false, 
      error: error.message,
      stack: error.stack // Include stack trace for debugging
    };
  }
}

// Queue status monitoring
export function getQueueStatus() {
  return {
    extraction: {
      pending: extractionQueue.size,
      processing: extractionQueue.isPaused ? 0 : extractionQueue.pending.length
    },
    download: {
      pending: downloadQueue.size,
      processing: downloadQueue.isPaused ? 0 : downloadQueue.pending.length
    },
    sending: {
      pending: sendingQueue.size,
      processing: sendingQueue.isPaused ? 0 : sendingQueue.pending.length
    }
  };
}

// Utility to handle queue errors and backpressure
function setupQueueErrorHandling(queue, name) {
  queue.on('error', (error, job) => {
    logger.error(`Error in ${name} queue:`, error);
    // Job will be automatically removed from queue
  });
  
  // Handle backpressure by monitoring queue size
  setInterval(() => {
    if (queue.size > 20) {
      logger.warn(`${name} queue is experiencing backpressure: ${queue.size} items pending`);
      if (!queue.isPaused) {
        queue.pause();
        setTimeout(() => queue.resume(), 10000); // Resume after 10 seconds
      }
    }
  }, 5000);
}

// Setup error handling for all queues
setupQueueErrorHandling(extractionQueue, 'Extraction');
setupQueueErrorHandling(downloadQueue, 'Download');
setupQueueErrorHandling(sendingQueue, 'Sending');
