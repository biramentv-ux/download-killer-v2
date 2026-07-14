import { previewMetadata, resolvePlaylist } from "./api.js";
import { spotifyTrackId, spotifyTrackUrl } from "./validators.js";

export async function fetchMetadata(uriOrUrl, backendUrl) {
  const url = spotifyTrackUrl(uriOrUrl);
  if (!url) throw new Error("Невалиден Spotify track URL или URI");

  const metadata = await previewMetadata(backendUrl, url);
  return {
    id: spotifyTrackId(url),
    url,
    title: metadata.title || "Spotify track",
    artist: metadata.artist || "Unknown artist",
    album: metadata.album || "",
    duration: metadata.duration || 0,
    cover_url: metadata.thumbnail || "",
    spotify_url: url
  };
}

export async function fetchPlaylistMetadata(playlistUrl, backendUrl) {
  const playlist = await resolvePlaylist(backendUrl, playlistUrl);
  return {
    name: playlist.title,
    tracks: playlist.tracks.map((track) => ({
      url: String(track.url || ""),
      title: String(track.title || "Spotify track"),
      artist: String(track.artist || "Unknown artist")
    })).filter((track) => track.url)
  };
}
