// TLS termination only: byte-for-byte forwarding to real verify-only API processes.
import https from 'node:https';
import http from 'node:http';
import {readFileSync} from 'node:fs';
const [key,cert]=process.argv.slice(2);
for(const port of [18404,18405,18406]){
 https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  const upstream=http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  req.pipe(upstream);upstream.on('error',()=>res.destroy());
 }).listen(port+1000,'127.0.0.1',()=>console.log(`HTTPS API forwarding ${port+1000} -> ${port}`));
}
