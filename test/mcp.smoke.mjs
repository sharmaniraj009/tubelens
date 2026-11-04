// Live smoke test: spawns the MCP server over stdio and calls each tool. Needs network.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const env = { ...process.env }; if (process.argv[2] !== "--with-key") delete env.YOUTUBE_API_KEY;
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../mcp/server.mjs", import.meta.url).pathname], env }));
const { tools } = await client.listTools(); const { prompts } = await client.listPrompts();
console.log("tools:", tools.map(t => t.name).join(", ")); console.log("prompts:", prompts.map(p => p.name).join(", "));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content[0].text; console.log(`\n# ${name}${r.isError ? " (error)" : ""}\n` + t.slice(0, 600)); return r; };
await call("get_videos", { videos: ["https://youtu.be/jNQXAC9IVRw"], include_description: false });
await call("score_metadata", { title: "Home Workout for Beginners (No Equipment)", tags: ["home workout for beginners", "home workout"] });
await call("keyword_ideas", { seed: "thumbnail design", limit: 5 });
await call("search_videos", { query: "home workout" });
await call("get_videos", { videos: ["not a video"] });
const p = await client.getPrompt({ name: "write_titles", arguments: { topic: "budget travel in Japan" } });
console.log("\n# prompt write_titles:", p.messages[0].content.text.slice(0, 160));
await client.close();
