const fs = require('fs');
const path = require('path');

const CONFIG = {
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
  SPREADSHEET_ID: '2PACX-1vTlFYSEP7Prs4aDZ9qKFrMvk2oikkqViTAwyTASE2d1E6a59dWcMM4IO-L3QJ_G5wZ_SwkLAKN4pG3h',
  SHEETS: {
    sspx: 0,
    'non-sspx': 309403613
  }
};

async function fetchChannelsFromSheet(category) {
  const gid = CONFIG.SHEETS[category];
  const url = `https://docs.google.com/spreadsheets/d/e/${CONFIG.SPREADSHEET_ID}/pub?gid=${gid}&single=true&output=csv`;
  
  console.log(`Fetching ${category} channels...`);
  
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to fetch from Google Sheets');
  
  const csvText = await response.text();
  return parseCSV(csvText);
}

function parseCSV(csvText) {
  const lines = csvText.split('\n');
  const channels = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = parseCSVLine(line);
    
    if (values.length >= 3) {
      channels.push({
        name: values[0].replace(/^"|"$/g, '').trim(),
        url: values[1].replace(/^"|"$/g, '').trim(),
        channelId: values[2].replace(/^"|"$/g, '').trim()
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

async function fetchChannelLivestreams(channelId, channelName) {
  const apiKey = CONFIG.YOUTUBE_API_KEY;
  
  try {
    const uploadsPlaylistId = 'UU' + channelId.substring(2);
    
    const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=15&key=${apiKey}`;
    
    const playlistResponse = await fetch(playlistUrl);
    const playlistData = await playlistResponse.json();
    
    if (playlistData.error) {
      console.log(`  Error for ${channelName}: ${playlistData.error.message}`);
      return [];
    }
    
    if (!playlistData.items || playlistData.items.length === 0) {
      return [];
    }
    
    const videoIds = playlistData.items.map(item => item.contentDetails.videoId).join(',');
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails,status&id=${videoIds}&key=${apiKey}`;
    
    const videosResponse = await fetch(videosUrl);
    const videosData = await videosResponse.json();
    
    if (videosData.error) {
      throw new Error(videosData.error.message);
    }
    
    const videos = [];
    const now = new Date();
    const next24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    for (const item of (videosData.items || [])) {
      const liveDetails = item.liveStreamingDetails;
      const liveBroadcastContent = item.snippet.liveBroadcastContent;
      
      if (liveBroadcastContent === 'none' && !liveDetails) continue;
      
      const actualEndTime = liveDetails?.actualEndTime;
      const actualStartTime = liveDetails?.actualStartTime;
      const scheduledTime = liveDetails?.scheduledStartTime;
      
      // Skip jika video sudah selesai
      if (actualEndTime) continue;
      
      // Video LIVE
      if (liveBroadcastContent === 'live' || (actualStartTime && !actualEndTime)) {
        videos.push({
          id: item.id,
          title: item.snippet.title,
          channel: channelName,
          channelId: channelId,
          thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
          status: 'live',
          scheduledTime: null
        });
        continue;
      }
      
      // Video UPCOMING - HANYA jika punya scheduledStartTime yang valid
      if (liveBroadcastContent === 'upcoming' && scheduledTime) {
        const scheduleDate = new Date(scheduledTime);
        
        // Validasi: scheduledTime harus valid date
        if (isNaN(scheduleDate.getTime())) {
          console.log(`  Skipping ${item.snippet.title}: Invalid scheduled time`);
          continue;
        }
        
        // Skip jika sudah lewat lebih dari 1 jam
        if (scheduleDate < now) {
          const hoursPassed = (now - scheduleDate) / (1000 * 60 * 60);
          if (hoursPassed > 1) {
            console.log(`  Skipping ${item.snippet.title}: Overdue by ${hoursPassed.toFixed(1)} hours`);
            continue;
          }
        }
        
        // Skip jika lebih dari 24 jam ke depan
        if (scheduleDate > next24Hours) {
          console.log(`  Skipping ${item.snippet.title}: More than 24h away`);
          continue;
        }
        
        videos.push({
          id: item.id,
          title: item.snippet.title,
          channel: channelName,
          channelId: channelId,
          thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
          status: 'upcoming',
          scheduledTime: scheduledTime
        });
      }
      // Jika upcoming tapi TIDAK punya scheduledTime, SKIP (tidak ditampilkan)
      else if (liveBroadcastContent === 'upcoming' && !scheduledTime) {
        console.log(`  Skipping ${item.snippet.title}: No scheduled time (uncertain)`);
        continue;
      }
    }
    
    return videos;
  } catch (error) {
    console.error(`Error fetching ${channelName}:`, error.message);
    return [];
  }
}

async function main() {
  console.log('Starting data fetch...');
  console.log('Time:', new Date().toISOString());
  
  if (!CONFIG.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY is not set');
  }
  
  const result = {
    lastUpdated: new Date().toISOString(),
    categories: {
      sspx: { name: 'SSPX Latin Mass', videos: [] },
      'non-sspx': { name: 'Non-SSPX Latin Mass', videos: [] }
    }
  };
  
  for (const category of ['sspx', 'non-sspx']) {
    console.log(`\nProcessing ${category}...`);
    
    try {
      const channels = await fetchChannelsFromSheet(category);
      console.log(`Found ${channels.length} channels`);
      
      const allVideos = [];
      
      for (const channel of channels) {
        console.log(`  Fetching: ${channel.name}`);
        const videos = await fetchChannelLivestreams(channel.channelId, channel.name);
        allVideos.push(...videos);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      allVideos.sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (a.status !== 'live' && b.status === 'live') return 1;
        if (a.scheduledTime && b.scheduledTime) {
          return new Date(a.scheduledTime) - new Date(b.scheduledTime);
        }
        return 
