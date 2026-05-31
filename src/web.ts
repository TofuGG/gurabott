import HTTP from 'node:http';

const PORT = process.env.PORT || 5500;

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
				status: 'online',
				service: 'Gurabott',
				timestamp: new Date().toISOString(),
				uptime: process.uptime()
			}));
		} else if (request.url === '/status') {
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
	</style>
</head>
<body>
	<div class="container">
		<div class="status">
			<h1>🤖 Gurabott Status</h1>
			<div class="info">
				<p>✓ Bot is running</p>
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

	server.listen(PORT, () => {
		console.log(`\n🌐 Health check server running on http://localhost:${PORT}`);
		console.log(`   GET ${PORT}/health - JSON status`);
		console.log(`   GET ${PORT}/status - HTML status page`);
		console.log(`   GET 3007 - Live bot viewer\n`);
	});
};
