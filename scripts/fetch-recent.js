const fs = require('fs');
const path = require('path');

const CONFIG = {
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
  SPREADSHEET_ID: '2PACX-1vTlFYSEP7Prs4aDZ9qKFrMvk2oikkqViTAwyTASE2d1E6a59dWcMM4IO-L3QJ_G5wZ_SwkLAKN4pG3h',
  SHEET_GID: '1666416706'
};

// Fetch channels from Google Sheets
async function fetchChannelsFromSheet() {
  const url = `https://docs.google.com/spreadsheets/d/e/${CONFIG.SPREADSHEET_ID}/pub?gid=${CONFIG.SHEET_GID}&single=true&output=csv`;
  
  console.log('Fetching channels from Google Sheets...');
  console.log('URL:', url);
  
  const response = await fetch(url);
  
  if (!response.ok) throw new Error('Failed to fetch from Google Sheets');
  
  const csvText = await response.text();
  console.log('CSV Preview:', csvText.substring(0, 300));
  return parseCSV(csvText);
}

// Parse CSV
function parseCSV(csvText) {
  const lines = csvText.split('\n');
  const channels = [];
  
  // Skip header (first row)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = parseCSVLine(line);
    
    if (values.length >= 4) {
      channels.push({
        channelId: values[0].replace(/^"|"$/g, '').trim(),
        maxDays: parseInt(values[1]) || 7,
        maxVideos: parseInt(values[2]) || 5,
        description: values[3].replace(/^"|"$/g, '').trim()
      });
    }
  }
  
  return channels;
}

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  
  return values;
}

// Fetch recent videos from a channel
async function fetchChannelVideos(channel) {
  const apiKey = CONFIG.YOUTUBE_API_KEY;
  const { channelId, maxDays, maxVideos, description } = channel;
  
  try {
    // Convert Channel ID to Uploads Playlist ID (UC... -> UU...)
    const uploadsPlaylistId = 'UU' + channelId.substring(2);
    
    // Step 1: Get recent videos from uploads playlist
    const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${Math.min(maxVideos * 2, 50)}&key=${apiKey}`;
    
    const playlistResponse = await fetch(playlistUrl);
    const playlistData = await playlistResponse.json();
    
    if (playlistData.error) {
      console.log(`  Error: ${playlistData.error.message}`);
      return [];
    }
    
    if (!playlistData.items || playlistData.items.length === 0) {
      return [];
    }
    
    // Step 2: Get video details
    const videoIds = playlistData.items.map(item => item.contentDetails.videoId).join(',');
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds}&key=${apiKey}`;
    
    const videosResponse = await fetch(videosUrl);
    const videosData = await videosResponse.json();
    
    if (videosData.error) {
      throw new Error(videosData.error.message);
    }
    
    const videos = [];
    const now = new Date();
    const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
    
    for (const item of (videosData.items || [])) {
      const publishedAt = new Date(item.snippet.publishedAt);
      const ageMs = now - publishedAt;
      
      // Skip if video is older than maxDays
      if (ageMs > maxAgeMs) {
        continue;
      }
      
      // Skip livestreams (only regular videos)
      if (item.snippet.liveBroadcastContent !== 'none') {
        continue;
      }
      
      videos.push({
        id: item.id,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        channelId: channelId,
        description: item.snippet.description?.substring(0, 200) || '',
        thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
        publishedAt: item.snippet.publishedAt,
        category: description
      });
      
      // Limit to maxVideos
      if (videos.length >= maxVideos) {
        break;
      }
    }
    
    return videos;
  } catch (error) {
    console.error(`Error fetching ${description}:`, error.message);
    return [];
  }
}

// Main function
async function main() {
  console.log('Starting recent videos fetch...');
  console.log('Time:', new Date().toISOString());
  
  if (!CONFIG.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY is not set');
  }
  
  const result = {
    lastUpdated: new Date().toISOString(),
    videos: []
  };
  
  try {
    const channels = await fetchChannelsFromSheet();
    console.log(`Found ${channels.length} channels`);
    
    const allVideos = [];
    
    for (const channel of channels) {
      console.log(`  Fetching: ${channel.description} (max ${channel.maxVideos} videos, ${channel.maxDays} days)`);
      const videos = await fetchChannelVideos(channel);
      console.log(`    Found ${videos.length} videos`);
      allVideos.push(...videos);
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Sort by publishedAt (newest first)
    allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    
    result.videos = allVideos;
    console.log(`\nTotal videos: ${allVideos.length}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
  
  // Ensure data directory exists
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // Write to JSON file
  const outputPath = path.join(dataDir, 'recent-videos.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  
  console.log(`Saved to ${outputPath}`);
  console.log('Done!');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
