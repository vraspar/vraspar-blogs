<script lang="ts">
import { onMount } from "svelte";
import {
	DOODLE_API_PATH,
	DOODLE_HEIGHT,
	DOODLE_WIDTH,
	type PublicDoodle,
	type PublicDoodleList,
} from "@/utils/doodles/shared";

const PAGE_SIZE = 12;

let items: PublicDoodle[] = $state([]);
let loading = $state(true);
let failed = $state(false);
let shown = $state(PAGE_SIZE);
let viewing: PublicDoodle | null = $state(null);
let dialog: HTMLDialogElement | undefined = $state();

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

async function load() {
	loading = true;
	failed = false;
	try {
		const response = await fetch(DOODLE_API_PATH, {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = (await response.json()) as PublicDoodleList;
		items = Array.isArray(body.items) ? body.items : [];
	} catch (error) {
		console.warn("[doodles] could not load the wall", error);
		failed = true;
	} finally {
		loading = false;
	}
}

function open(item: PublicDoodle) {
	viewing = item;
	dialog?.showModal();
}

function onDialogClick(event: MouseEvent) {
	if (event.target === dialog) dialog?.close();
}

onMount(load);
</script>

<div class="doodle-wall" aria-busy={loading}>
	<div class="doodle-wall__header">
		<h3 class="doodle-wall__title">On the wall</h3>
		{#if !loading && !failed && items.length > 0}
			<span class="doodle-wall__count">{items.length}</span>
		{/if}
	</div>

	{#if loading}
		<div class="doodle-grid" aria-hidden="true">
			{#each [1, 2, 3, 4] as n (n)}
				<div class="doodle-card">
					<div class="doodle-card__image animate-pulse bg-(--btn-regular-bg)"></div>
					<div class="mt-2 h-3 w-2/3 rounded bg-(--btn-regular-bg) animate-pulse"></div>
				</div>
			{/each}
		</div>
	{:else if failed}
		<div class="doodle-empty">
			<p>Couldn't load the wall right now.</p>
			<button type="button" class="doodle-action mt-3" onclick={load}>Try again</button>
		</div>
	{:else if items.length === 0}
		<div class="doodle-empty">
			<svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="6" y="10" width="36" height="28" rx="4" />
				<path d="M13 30c3-6 6-9 9-5s5 3 8-2 5-3 6 0" />
				<circle cx="34" cy="18" r="2.5" />
			</svg>
			<p>Nothing on the wall yet. Yours could be the first.</p>
		</div>
	{:else}
		<ul class="doodle-grid">
			{#each items.slice(0, shown) as item (item.id)}
				<li class="doodle-card">
					<button
						type="button"
						class="doodle-card__open"
						onclick={() => open(item)}
						aria-label="View the doodle{item.name ? ` by ${item.name}` : ''} larger"
					>
						<img
							class="doodle-card__image"
							src={item.image}
							alt={item.note || (item.name ? `Doodle by ${item.name}` : "A visitor's doodle")}
							width={DOODLE_WIDTH}
							height={DOODLE_HEIGHT}
							loading="lazy"
							decoding="async"
						/>
					</button>
					<div class="doodle-card__meta">
						<span class="doodle-card__name">{item.name || "Anonymous"}</span>
						<time class="doodle-card__date" datetime={item.approvedAt}>{formatDate(item.approvedAt)}</time>
					</div>
					{#if item.note}
						<p class="doodle-card__note">{item.note}</p>
					{/if}
				</li>
			{/each}
		</ul>
		{#if items.length > shown}
			<div class="mt-4 flex justify-center">
				<button type="button" class="doodle-action" onclick={() => (shown += PAGE_SIZE)}>
					Show more ({items.length - shown})
				</button>
			</div>
		{/if}
	{/if}

	<dialog bind:this={dialog} class="doodle-dialog" onclick={onDialogClick} onclose={() => (viewing = null)}>
		{#if viewing}
			<figure>
				<img src={viewing.image} alt={viewing.note || "Doodle"} width={DOODLE_WIDTH * 2} height={DOODLE_HEIGHT * 2} />
				<figcaption>
					<strong>{viewing.name || "Anonymous"}</strong>
					{#if viewing.note}<span>{viewing.note}</span>{/if}
				</figcaption>
			</figure>
			<form method="dialog">
				<button type="submit" class="doodle-dialog__close" aria-label="Close">
					<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
						<path d="M6 6l12 12M18 6 6 18" />
					</svg>
				</button>
			</form>
		{/if}
	</dialog>
</div>
