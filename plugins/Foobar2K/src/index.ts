import { intercept } from "@neptune";
import { Tracer } from "@inrixia/lib/trace";
import { MediaItemCache } from "@inrixia/lib/Caches/MediaItemCache";

const trace = Tracer("[Foobar2K]");

const unloadTransition = intercept(
	"playbackControls/MEDIA_PRODUCT_TRANSITION",
	([media]) => {
		const mediaProduct = media.mediaProduct as { productId: string };
		MediaItemCache.ensure(mediaProduct.productId)
			.then((track) => {
				if (track)
					(() => {
						fetch("http://localhost:8880/api/playlists/p1/items/add", {
							mode: "no-cors",
							headers: {
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								items: [`http://localhost:8881/${track.id}`],
								replace: true,
								play: true,
							}),
							method: "POST",
						});

						neptune.actions.playbackControls.stop();
					})();
			})
			.catch(trace.err.withContext("Failed to fetch media item"));
	},
);

export const onUnload = () => {
	unloadTransition();
};
