/** API image inputs become validated DSH attachments before model dispatch. */
import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import type { Context } from '@deepseek-ai/cordis';
import type { AttachmentAdmissionPart, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
import type { ModelUserContent } from '@software-factory/contracts/runtime';
import { ensure } from './validation.ts';

const resolveAddresses = promisify(lookup);
const mediaTypes: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function isPublic(address: string): boolean {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  return parsed.range() === 'unicast';
}
function mediaType(value: string): ImageMediaType {
  ensure(mediaTypes.includes(value as ImageMediaType), 'INVALID_IMAGE', '只支持PNG、JPEG、GIF、WebP图片');
  return value as ImageMediaType;
}

async function imageAddresses(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    void resolveAddresses(hostname, { all: true, order: 'verbatim' }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}

function imageType(data: Buffer): ImageMediaType {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  ensure(false, 'INVALID_IMAGE', '下载内容不是PNG、JPEG、GIF或WebP图片');
}

/** Download anonymously, following only validated public destinations and host proxy policy. */
async function downloadImage(source: string, maxBytes: number, signal: AbortSignal): Promise<{ data: string; mediaType: ImageMediaType }> {
  ensure(source.length <= 8192, 'INVALID_IMAGE_URL', '图片URL过长');
  let url = new URL(source);
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted();
    ensure(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'INVALID_IMAGE_URL', '图片URL必须是无账号密码的HTTP(S)地址');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    ensure(!isIP(hostname) || isPublic(hostname), 'IMAGE_URL_BLOCKED', '图片URL不能访问本地或私有网络');
    const route = proxyRouteFor(url);
    let ownAgent: Agent | undefined;
    if (!route.proxied) {
      const addresses = await imageAddresses(hostname, signal);
      signal.throwIfAborted();
      ensure(addresses.length > 0 && addresses.every(a => isPublic(a.address)), 'IMAGE_URL_BLOCKED', '图片URL不能访问本地或私有网络');
      // Pin the addresses already checked above; do not resolve again during connection.
      ownAgent = new Agent({ connect: { lookup: (_host: string, options: LookupOptions, done: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
        const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const eligible = family ? addresses.filter(a => a.family === family) : addresses;
        if (!eligible.length) done(Object.assign(new Error('图片地址没有匹配的IP类型'), { code: 'ENOTFOUND' }), []);
        else if (options.all) done(null, eligible);
        else done(null, eligible[0].address, eligible[0].family);
      } } });
    }
    const response = await fetch(url, {
      redirect: 'manual', signal,
      headers: { accept: 'image/png,image/jpeg,image/gif,image/webp', 'user-agent': 'software-factory-runtime' },
      dispatcher: route.proxied ? route.dispatcher : ownAgent,
    }).catch(async error => { await ownAgent?.close(); throw error; });
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        ensure(location && hop < 3, 'INVALID_IMAGE_URL', '图片URL重定向过多或缺少目标');
        url = new URL(location, url); continue;
      }
      ensure(response.ok && response.body, 'IMAGE_DOWNLOAD_FAILED', '图片下载失败，HTTP ' + response.status);
      ensure(Number(response.headers.get('content-length') ?? 0) <= maxBytes, 'IMAGE_TOO_LARGE', '图片超过DSH附件大小限制');
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        ensure(size <= maxBytes, 'IMAGE_TOO_LARGE', '图片超过DSH附件大小限制');
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      const bytes = Buffer.concat(chunks);
      return { mediaType: imageType(bytes), data: bytes.toString('base64') };
    } finally {
      await response.body?.cancel().catch(() => {});
      await ownAgent?.close();
    }
  }
  throw new Error('图片URL重定向过多');
}

export async function userContent(ctx: Context, content: ModelUserContent, signal: AbortSignal): Promise<ContentBlock[]> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!content.some(part => part.type === 'image_url')) return content.map(part => ({ type: 'text', text: (part as { text: string }).text }));
  const attachments = ctx.get('attachments');
  ensure(attachments, 'IMAGE_SERVICE_UNAVAILABLE', '图片请求需要DSH附件服务');
  const count = content.filter(part => part.type === 'image_url').length;
  ensure(count <= attachments.imageLimits.maxImagesPerMessage, 'TOO_MANY_IMAGES', '图片数量超过DSH附件限制');
  const parts: AttachmentAdmissionPart[] = [];
  let imageBytes = 0;
  for (const part of content) {
    signal.throwIfAborted();
    if (part.type === 'text') { parts.push(part); continue; }
    const url = part.image_url.url;
    let image: { data: string; mediaType: ImageMediaType };
    if (url.startsWith('data:')) {
      ensure(url.length <= Math.ceil(attachments.imageLimits.maxImageBytes / 3) * 4 + 128, 'IMAGE_TOO_LARGE', '图片超过DSH附件大小限制');
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
      ensure(match, 'INVALID_IMAGE', '图片必须使用data:image/...;base64,...格式');
      image = { mediaType: mediaType(match[1]), data: match[2] };
    } else {
      image = await downloadImage(url, attachments.imageLimits.maxImageBytes, signal);
    }
    imageBytes += Buffer.byteLength(image.data, 'base64');
    ensure(imageBytes <= attachments.imageLimits.maxMessageImageBytes, 'IMAGES_TOO_LARGE', '图片总大小超过DSH附件限制');
    parts.push({ type: 'image', ...image });
  }
  const admitted = await attachments.admitPromptContent(parts);
  signal.throwIfAborted();
  return admitted;
}
