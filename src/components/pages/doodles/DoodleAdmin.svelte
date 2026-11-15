<script lang="ts">
// Owner-only moderation for the doodle wall (src/pages/admin/doodles.astro).
// The token lives in sessionStorage for this tab only and is sent as a Bearer
// header; images are fetched with it and shown through object URLs.
import { onDestroy, onMount } from "svelte";
import {
	type AdminDoodle,
	type AdminDoodleList,
	adminImageUrl,
	DOODLE_API_PATH,
	DOODLE_HEIGHT,
	DOODLE_WIDTH,
} from "@/utils/doodles/shared";

const STORAGE_KEY = "doodle-admin-token";

let token = $state("");
let draft = $state("");
let unlocked = $state(false);
let loading = $state(false);
let error = $state("");
let storage = $state("");
let pending: AdminDoodle[] = $state([]);
let approved: AdminDoodle[] = $state([]);
let busy: Record<string, boolean> = $state({});
let images: Record<string, string> = $state({});

const dateFormat = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

function readStored(): string {
	try {
		return sessionStorage.getItem(STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

function store(value: string) {
	try {
		if (value) sessionStorage.setItem(STORAGE_KEY, value);
		else sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// storage blocked: the token just won't survive a reload
	}
}

async function api(query: string, method = "GET"): Promise<Response> {
	return fetch(`${DOODLE_API_PATH}?${query}`, {
		method,
		headers: { Authorization: `Bearer ${token}` },
		cache: "no-store",
	});
}

async function failure(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string };
		if (body.error) return body.error;
	} catch {
		// not JSON
	}
	return `Request failed (HTTP ${response.status}).`;
}

function key(item: AdminDoodle): string {
	return `${item.status}:${item.id}`;
}

async function loadImage(item: AdminDoodle) {
	const k = key(item);
	if (images[k]) return;
	try {
		const response = await fetch(adminImageUrl(item.id, item.status), {
			headers: { Authorization: `Bearer ${token}` },
			cache: "no-store",
		});
		if (response.ok) images[k] = URL.createObjectURL(await response.blob());
	} catch {
		// leave the placeholder
	}
}

async function refresh() {
	loading = true;
	error = "";
	try {
		const response = await api("admin=list");
		if (response.status === 401) {
			lock();
			error = "That token didn't work.";
			return;
		}
		if (!response.ok) {
			error = await failure(response);
			return;
		}
		const body = (await response.json()) as AdminDoodleList;
		unlocked = true;
		storage = body.storage;
		pending = body.pending;
		approved = body.approved;
		for (const item of [...pending, ...approved]) loadImage(item);
	} catch {
		error = "Couldn't reach the server.";
	} finally {
		loading = false;
	}
}

async function act(item: AdminDoodle, action: "approve" | "reject" | "remove") {
	if (
		action === "reject" &&
		!confirm("Delete this doodle? This can't be undone.")
	)
		return;
	if (
		action === "remove" &&
		!confirm(
			"Take this doodle off the wall and delete it? This can't be undone.",
		)
	)
		return;
	busy[item.id] = true;
	error = "";
	try {
		const response = await api(
			`admin=${action}&id=${encodeURIComponent(item.id)}`,
			"POST",
		);
		if (!response.ok) {
			error = await failure(response);
			return;
		}
		await refresh();
	} catch {
		error = "Couldn't reach the server.";
	} finally {
		busy[item.id] = false;
	}
}

function unlock(event: SubmitEvent) {
	event.preventDefault();
	token = draft.trim();
	draft = "";
	if (!token) return;
	store(token);
	refresh();
}

function lock() {
	token = "";
	unlocked = false;
	pending = [];
	approved = [];
	store("");
	for (const url of Object.values(images)) URL.revokeObjectURL(url);
	images = {};
}

function formatDate(iso?: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

onMount(() => {
	token = readStored();
	if (token) refresh();
});

onDestroy(() => {
	for (const url of Object.values(images)) URL.revokeObjectURL(url);
});
</script>

{#snippet card(item: AdminDoodle)}
	<li class="doodle-card">
		{#if images[key(item)]}
			<img class="doodle-card__image" src={images[key(item)]} alt="Doodle {item.id}" width={DOODLE_WIDTH} height={DOODLE_HEIGHT} />
		{:else}
			<div class="doodle-card__image animate-pulse bg-(--btn-regular-bg)"></div>
		{/if}
		<div class="doodle-card__meta">
			<span class="doodle-card__name">{item.name || "Anonymous"}</span>
			<time class="doodle-card__date" datetime={item.approvedAt ?? item.createdAt}>
				{formatDate(item.approvedAt ?? item.createdAt)}
			</time>
		</div>
		{#if item.note}
			<p class="doodle-card__note">{item.note}</p>
		{/if}
		<div class="mt-3 flex flex-wrap gap-2">
			{#if item.status === "pending"}
				<button type="button" class="doodle-submit__button doodle-submit__button--small" disabled={busy[item.id]} onclick={() => act(item, "approve")}>
					Approve
				</button>
				<button type="button" class="doodle-action doodle-action--danger" disabled={busy[item.id]} onclick={() => act(item, "reject")}>
					Reject
				</button>
			{:else}
				<button type="button" class="doodle-action doodle-action--danger" disabled={busy[item.id]} onclick={() => act(item, "remove")}>
					Remove from wall
				</button>
			{/if}
		</div>
	</li>
{/snippet}

<div class="doodle-admin">
	{#if !unlocked}
		<form class="doodle-admin__unlock" onsubmit={unlock}>
			<label class="doodle-field">
				<span class="doodle-field__label">Admin token</span>
				<input type="password" bind:value={draft} autocomplete="current-password" required />
			</label>
			<button type="submit" class="doodle-submit__button" disabled={loading}>
				{loading ? "Checking…" : "Unlock"}
			</button>
		</form>
		<p class="mt-3 text-sm text-(--content-meta)">
			The token is the <code>DOODLE_ADMIN_TOKEN</code> environment variable. It is kept in this tab's session storage until you lock the page or close the tab.
		</p>
	{:else}
		<div class="flex flex-wrap items-center gap-3 mb-4">
			<button type="button" class="doodle-action" onclick={refresh} disabled={loading}>
				{loading ? "Refreshing…" : "Refresh"}
			</button>
			<button type="button" class="doodle-action" onclick={lock}>Lock</button>
			<span class="text-xs text-(--content-meta)">Storage: {storage}</span>
		</div>

		<h3 class="doodle-wall__title mb-3">Waiting for review ({pending.length})</h3>
		{#if pending.length === 0}
			<p class="doodle-empty">Nothing waiting. All caught up.</p>
		{:else}
			<ul class="doodle-grid">
				{#each pending as item (item.id)}
					{@render card(item)}
				{/each}
			</ul>
		{/if}

		<h3 class="doodle-wall__title mt-8 mb-3">On the wall ({approved.length})</h3>
		<p class="mb-3 text-sm text-(--content-meta)">
			The public wall is cached for about a minute, so changes can take that long to show up there.
		</p>
		{#if approved.length === 0}
			<p class="doodle-empty">The wall is empty.</p>
		{:else}
			<ul class="doodle-grid">
				{#each approved as item (item.id)}
					{@render card(item)}
				{/each}
			</ul>
		{/if}
	{/if}

	{#if error}
		<p class="doodle-status is-error mt-4" role="alert">{error}</p>
	{/if}
</div>
