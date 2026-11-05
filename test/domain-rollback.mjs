import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const dir=await mkdtemp(path.join(tmpdir(),'nui-domain-rollback-'));
try {
 const files=['config.json','Caddyfile','cert.pem','cert.key','domain.json'];
 const values=['{"userHost":"old.example.com"}','old proxy','old cert','old key','{"userHost":"old.example.com"}'];
 for(let i=0;i<files.length;i++)await writeFile(path.join(dir,files[i]),values[i],{mode:0o600});
 await writeFile(path.join(dir,'caddy'), '#!/bin/sh\necho simulated-validation-failure >&2\nexit 1\n',{mode:0o700});
 const code=`import {applyRequest} from './server/domain.js';console.log(JSON.stringify(applyRequest({settings:{mode:'domain',userHost:'new.example.com',cdn:'none'},certPem:'-----BEGIN CERTIFICATE-----\\nnew',keyPem:'-----BEGIN PRIVATE KEY-----\\nnew'})));`;
 const r=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,NUI_CONF_FILE:path.join(dir,files[0]),NUI_CADDY_FILE:path.join(dir,files[1]),NUI_CF_CERT_FILE:path.join(dir,files[2]),NUI_CF_KEY_FILE:path.join(dir,files[3]),NUI_DATA_DIR:dir,NUI_CADDY_BIN:path.join(dir,'caddy')}}));
 assert(!r.ok&&r.rolledBack);for(let i=0;i<files.length;i++)assert.equal(await readFile(path.join(dir,files[i]),'utf8'),values[i]);
 console.log('PASS privileged Caddy validation failure restores config, runtime domain, Caddyfile, certificate and key');
}finally{await rm(dir,{recursive:true,force:true});}
