/**
 * Which adapter serves which network. Stage 1: Threads and Instagram through the owner's own Meta app.
 * TikTok (through Zernio) and YouTube (own Google app) are declared with their limits and switched off
 * until stage 2 brings video; they never pretend to publish.
 */
import { instagramAdapter, instagramCapabilities } from './instagram';
import { threadsAdapter, threadsCapabilities } from './threads';
import { PublishError, type Capabilities, type Platform, type Provider, type PublisherAdapter } from './types';
import type { Fetch } from './meta';

export const PROVIDERS: { provider: Provider; platform: Platform; name: string; capabilities: Capabilities }[] = [
  { provider: 'meta_threads', platform: 'threads', name: 'Threads (своё приложение Meta)', capabilities: threadsCapabilities },
  { provider: 'meta_instagram', platform: 'instagram', name: 'Instagram (своё приложение Meta)', capabilities: instagramCapabilities },
  { provider: 'zernio', platform: 'tiktok', name: 'TikTok через Zernio', capabilities: { formats: ['video'], maxText: 2200, minCarousel: 0, maxCarousel: 0, imageTypes: [], maxImageBytes: 0, nativeScheduling: true, insights: true, dailyLimit: 15, inactive: 'Этап 2: публикация видео в TikTok через Zernio.' } },
  { provider: 'youtube', platform: 'youtube', name: 'YouTube (своё приложение Google)', capabilities: { formats: ['video'], maxText: 5000, minCarousel: 0, maxCarousel: 0, imageTypes: [], maxImageBytes: 0, nativeScheduling: true, insights: true, dailyLimit: 6, inactive: 'Этап 2: загрузка видео через YouTube Data API.' } },
];
export const providerFor = (platform: Platform) => PROVIDERS.find(item => item.platform === platform)!;

export function adapterFor(provider: Provider, request: Fetch = fetch): PublisherAdapter {
  if (provider === 'meta_threads') return threadsAdapter(request);
  if (provider === 'meta_instagram') return instagramAdapter(request);
  const declared = PROVIDERS.find(item => item.provider === provider);
  throw new PublishError(declared?.capabilities.inactive || 'Эта соцсеть пока не подключена.', 'not_available');
}
