/**
 * Which adapter serves which network. Threads and Instagram publish through the owner's own Meta app. YouTube
 * connects through the owner's own Google app; its video publishing comes with the video stage. TikTok goes
 * through Zernio. A network that cannot publish yet says so; it never pretends to publish.
 */
import { instagramAdapter, instagramCapabilities } from './instagram';
import { threadsAdapter, threadsCapabilities } from './threads';
import { youtubeAdapter, youtubeCapabilities } from './youtube';
import { PublishError, type Capabilities, type Platform, type Provider, type PublisherAdapter } from './types';
import type { Fetch } from './meta';

export const PROVIDERS: { provider: Provider; platform: Platform; name: string; capabilities: Capabilities }[] = [
  { provider: 'meta_threads', platform: 'threads', name: 'Threads (своё приложение Meta)', capabilities: threadsCapabilities },
  { provider: 'meta_instagram', platform: 'instagram', name: 'Instagram (своё приложение Meta)', capabilities: instagramCapabilities },
  { provider: 'zernio', platform: 'tiktok', name: 'TikTok через Zernio', capabilities: { formats: ['video'], maxText: 2200, minCarousel: 0, maxCarousel: 0, imageTypes: [], maxImageBytes: 0, nativeScheduling: true, insights: true, dailyLimit: 15, inactive: 'Этап 2: публикация видео в TikTok через Zernio.' } },
  { provider: 'youtube', platform: 'youtube', name: 'YouTube (своё приложение Google)', capabilities: youtubeCapabilities },
];
export const providerFor = (platform: Platform) => PROVIDERS.find(item => item.platform === platform)!;

export function adapterFor(provider: Provider, request: Fetch = fetch): PublisherAdapter {
  if (provider === 'meta_threads') return threadsAdapter(request);
  if (provider === 'meta_instagram') return instagramAdapter(request);
  if (provider === 'youtube') return youtubeAdapter(request);
  const declared = PROVIDERS.find(item => item.provider === provider);
  throw new PublishError(declared?.capabilities.inactive || 'Эта соцсеть пока не подключена.', 'not_available');
}
