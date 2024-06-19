import { actions, intercept, store } from "@neptune";
import { PlaybackContext } from "../../../lib/AudioQualityTypes";
import { rejectNotOk, requestStream } from "../../../lib/fetchy";

import { LastFM, ScrobbleOpts } from "./LastFM";

import type { Album, MediaItem, TrackItem } from "neptune-types/tidal";
import { messageError } from "../../../lib/messageLogging";
import { interceptPromise } from "../../../lib/interceptPromise";

import { toBuffer } from "../../SongDownloader/src/lib/toBuffer";

import type { Release, UPCData } from "./types/UPCData";
import type { ISRCData } from "./types/ISRCData";
import type { ReleaseData } from "./types/ReleaseData";
import { fullTitle } from "../../../lib/fullTitle";
import { Recording } from "./types/Recording";

let totalPlayTime = 0;
let lastPlayStart: number | null = null;

const MIN_SCROBBLE_DURATION = 240000; // 4 minutes in milliseconds
const MIN_SCROBBLE_PERCENTAGE = 0.5; // Minimum percentage of song duration required to scrobble

let currentTrack: CurrentTrack;

const intercepters = [
	intercept("playbackControls/SET_PLAYBACK_STATE", ([state]) => {
		switch (state) {
			case "PLAYING": {
				lastPlayStart = Date.now();
				break;
			}
			default: {
				if (lastPlayStart !== null) totalPlayTime += Date.now() - lastPlayStart;
				lastPlayStart = null;
			}
		}
	}),
	intercept("playbackControls/MEDIA_PRODUCT_TRANSITION", ([{ playbackContext }]) => {
		if (currentTrack !== undefined) {
			if (lastPlayStart !== null) totalPlayTime += Date.now() - lastPlayStart;
			if (totalPlayTime >= MIN_SCROBBLE_DURATION || totalPlayTime >= +currentTrack.playbackContext.actualDuration * MIN_SCROBBLE_PERCENTAGE * 1000) {
				LastFM.scrobble(getTrackParams(currentTrack)).catch((err) => messageError(`last.fm - Failed to scrobble! ${err}`));
			}
		}

		// reset totalPlayTime & currentTrack as we started playing a new one
		totalPlayTime = 0;
		getCurrentTrack(<PlaybackContext>playbackContext).then((_currentTrack) => {
			LastFM.updateNowPlaying(getTrackParams((currentTrack = _currentTrack))).catch((err) => messageError(`last.fm - Failed to updateNowPlaying! ${err}`));
		});
	}),
];

type CurrentTrack = {
	trackItem: MediaItem["item"];
	playbackContext: PlaybackContext;
	playbackStart: number;
	album?: Album;
	recording?: Recording;
	releaseAlbum?: Release;
};
const getCurrentTrack = async (playbackContext?: PlaybackContext): Promise<CurrentTrack> => {
	const state = store.getState();
	playbackContext ??= <PlaybackContext>state.playbackControls.playbackContext;
	const mediaItems: Record<number, MediaItem> = state.content.mediaItems;
	const trackItem = mediaItems[+playbackContext.actualProductId];
	actions.content.loadAlbum({ albumId: trackItem?.item?.album?.id! });
	let [album, recording] = await Promise.all([
		await interceptPromise(["content/LOAD_ALBUM_SUCCESS"], [])
			.catch(() => undefined)
			.then((res) => res?.[0].album),
		await mbidFromIsrc(trackItem?.item?.isrc).catch(() => undefined),
	]);
	let releaseAlbum;
	if (recording?.id === undefined && album?.upc !== undefined) {
		releaseAlbum = await releaseAlbumFromUpc(album.upc);
		if (releaseAlbum !== undefined) recording = await recordingFromAlbum(releaseAlbum, trackItem.item);
	}
	return { trackItem: trackItem.item, playbackContext, playbackStart: Date.now(), recording, album, releaseAlbum };
};

getCurrentTrack().then((_currentTrack) => {
	LastFM.updateNowPlaying(getTrackParams((currentTrack = _currentTrack))).catch((err) => messageError(`last.fm - Failed to updateNowPlaying! ${err}`));
});

const getTrackParams = ({ trackItem, playbackContext, playbackStart, album, recording, releaseAlbum }: CurrentTrack) => {
	const artist = formatArtists(trackItem.artists ?? [{ name: trackItem.artist?.name }])!;

	const params: ScrobbleOpts = {
		track: recording?.title ?? fullTitle(<TrackItem>trackItem),
		artist,
		timestamp: (playbackStart / 1000).toFixed(0),
	};

	if (!!recording?.id) params.mbid = recording.id;

	const albumArtist = album?.artists?.map(({ name }) => name).join(",");
	if (!!albumArtist) params.albumArtist = albumArtist;

	if (!!releaseAlbum?.title) params.album = releaseAlbum?.title;
	else if (!!trackItem.album?.title) params.album = trackItem.album.title;

	if (!!trackItem.trackNumber) params.trackNumber = trackItem.trackNumber.toString();
	if (!!playbackContext.actualDuration) params.duration = playbackContext.actualDuration.toFixed(0);

	return params;
};
const formatArtists = (artists?: MediaItem["item"]["artists"]) => {
	const artist = artists?.map(({ name }) => name)?.filter((name) => name !== undefined)?.[0] ?? "";
	return artist.split(", ")[0];
};

const fetchJson = async <T>(url: string): Promise<T> => {
	const res = await requestStream(url).then(rejectNotOk);
	return JSON.parse((await toBuffer(res)).toString());
};
const mbidFromIsrc = async (isrc?: string) => {
	if (isrc !== undefined) return undefined;
	const isrcData = await fetchJson<ISRCData>(`https://musicbrainz.org/ws/2/isrc/${isrc}?fmt=json`);
	return isrcData?.recordings?.[0];
};
const releaseAlbumFromUpc = async (upc: string) => {
	const upcData = await fetchJson<UPCData>(`https://musicbrainz.org/ws/2/release/?query=barcode:${upc}&fmt=json`);
	return upcData.releases?.[0];
};
const recordingFromAlbum = async (releaseAlbum: Release, trackItem: MediaItem["item"]) => {
	if (releaseAlbum?.id === undefined) return undefined;
	const albumReleaseData = await fetchJson<ReleaseData>(`https://musicbrainz.org/ws/2/release/${releaseAlbum.id}?inc=recordings&fmt=json`);
	const albumTracks = albumReleaseData.media?.[0].tracks;
	const albumTrackRelease = albumTracks?.[trackItem.trackNumber! - 1];
	return albumTrackRelease?.recording;
};

export const onUnload = () => intercepters.forEach((unload) => unload());
