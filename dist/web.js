"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const PORT = process.PORT || 5500;
const server = node_http_1.default.createServer((request, response) => {
    response.writeHead(200, {
        "Access-Control-Allow-Origin": "https://replit.com",
        "Access-Control-Allow-Methods": "GET, PING, OPTIONS",
        "Content-Type": "text/html"
    });
    response.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gawr Gura Website</title><style>body{background-color:#000;color:#add8e6;margin:0;padding:0;font-family:Arial,sans-serif;text-align:center}img{max-width:100%;height:auto}</style></head><body><h1>Welcome to the Gawr Gura Website!</h1><p>This is a simple website dedicated to Gawr Gura, a popular VTuber.</p><img src="https://cdn.discordapp.com/attachments/1186717234719105035/1197952567825678416/qMXdJs6.png?ex=65cf9845&is=65bd2345&hm=b94e68dd0bbf3fcae4ce2deb&" alt="Gawr Gura Image"></body></html>`);
});
exports.default = () => {
    server.listen(PORT, () => console.log("Server for UptimeRobot is ready!"));
};
