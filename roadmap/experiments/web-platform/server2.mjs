import http from 'node:http';
import fs from 'node:fs';
// cross-origin "tile server": no CORP header; CORS only when ?cors=1
http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const h = { 'Content-Type': 'image/png' };
    if (u.searchParams.get('cors')) h['Access-Control-Allow-Origin'] = '*';
    res.writeHead(200, h);
    fs.createReadStream('www/landscape.png').pipe(res);
  })
  .listen(8766);
