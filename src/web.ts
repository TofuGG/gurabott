import HTTP from 'node:http';

const PORT = process.env.PORT || 5500;
let botConnected = false;
let botState = 'disconnected';

const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

export function setBotHealthStatus(connected: boolean, state: string): void {
    botConnected = connected;
    botState = state;
}

export default (): void => {
	const server = HTTP.createServer((request, response) => {
		// Health check endpoint for monitoring services
		if (request.url === '/health' || request.url === '/') {
			response.writeHead(200, {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, OPTIONS"
			});
			response.end(JSON.stringify({
				status: botConnected ? 'online' : 'disconnected',
				botState,
				service: 'Gurabott',
				timestamp: new Date().toISOString(),
				uptime: process.uptime()
			}));
		} else if (request.url === '/status') {
			const statusColor = botConnected ? '#00ff88' : '#ff4444';
			const statusText = botConnected ? `Connected (${escapeHtml(botState)})` : 'Disconnected';
			const statusIcon = botConnected ? '&#10003;' : '&#10007;';
			// Status page for monitoring
			response.writeHead(200, {
				"Content-Type": "text/html",
				"Cache-Control": "no-cache"
			});
			response.end(`
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Gurabott Status</title>
	<style>
		body { background: #1a1a1a; color: #00d4ff; font-family: monospace; padding: 20px; }
		.container { max-width: 600px; margin: 0 auto; }
		.status { padding: 20px; background: #0a0a0a; border: 2px solid #00d4ff; border-radius: 5px; }
		h1 { margin: 0; }
		.info { margin-top: 10px; font-size: 14px; }
		.status-dot { color: ${statusColor}; font-size: 18px; }
	</style>
</head>
<body>
	<div class="container">
		<div class="status">
			<h1>Gurabott Status</h1>
			<div class="info">
				<p class="status-dot">${statusIcon} Bot: ${statusText}</p>
				<p>Uptime: ${Math.floor(process.uptime())}s</p>
				<p>Timestamp: ${new Date().toISOString()}</p>
			</div>
		</div>
	</div>
</body>
</html>
			`);
		} else {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end('Not Found');
		}
	});

	server.on('error', (err: any) => {
		if (err.code === 'EADDRINUSE') {
			console.warn(`[WEB] Port ${PORT} in use, health server disabled`);
		} else {
			console.error(`[WEB] Health server error: ${err.message}`);
		}
	});

	server.listen(PORT, () => {
		console.log(`[WEB] Health check server running on http://localhost:${PORT}`);
		console.log(`[WEB]   GET /health - JSON status`);
		console.log(`[WEB]   GET /status - HTML status page`);
		console.log(`[WEB]   GET 3007 - Live bot viewer`);
	});
};
