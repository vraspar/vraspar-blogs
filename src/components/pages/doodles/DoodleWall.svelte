<script lang="ts">
// Guestbook doodle wall: one island with the drawing pad and the public wall.
// Loaded with client:visible from src/pages/guestbook.astro only.
import DoodleGrid from "./DoodleGrid.svelte";
import DoodlePad from "./DoodlePad.svelte";
</script>

<DoodlePad />
<DoodleGrid />
