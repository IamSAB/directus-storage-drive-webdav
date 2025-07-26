import type { ChunkedUploadContext, ReadOptions, TusDriver } from '@directus/storage';
import { relative } from 'node:path';
import { Readable } from 'stream';
import type { WebDAVClient } from 'webdav';
import { createClient } from 'webdav';

export type DriverWebDAVConfig = {
	baseUrl: string;
	username: string;
	password: string;
	root?: string; // optional prefix path within the WebDAV server
};

export class DriverWebDAV implements TusDriver {
	private readonly client: WebDAVClient;
	private readonly root: string;

	constructor(config: DriverWebDAVConfig) {
		this.client = createClient(config.baseUrl, {
			username: config.username,
			password: config.password,
		});
		this.root = config.root ?? '/';
	}

	private fullPath(filepath: string) {
		return `${this.root.replace(/\/$/, '')}/${filepath.replace(/^\//, '')}`;
	}

	async read(filepath: string, options?: ReadOptions): Promise<Readable> {
		const remotePath = this.fullPath(filepath);

		if (options?.range) {
			const { start, end } = options.range;
			const headers: Record<string, string> = {
				Range: `bytes=${start}-${end ?? ''}`,
			};
			return this.client.createReadStream(remotePath, { headers });
		}

		return this.client.createReadStream(remotePath);
	}

	async stat(filepath: string) {
		const remotePath = this.fullPath(filepath);
		const stat = await this.client.stat(remotePath);

		// If stat has a 'data' property, unwrap it
		const fileStat = 'data' in stat ? stat.data : stat;

		return {
			size: fileStat.size ?? 0,
			modified: fileStat.lastmod ? new Date(fileStat.lastmod) : new Date(),
		};
	}

	async exists(filepath: string) {
		try {
			const remotePath = this.fullPath(filepath);
			await this.client.stat(remotePath);
			return true;
		} catch {
			return false;
		}
	}

	async move(src: string, dest: string) {
		await this.client.moveFile(this.fullPath(src), this.fullPath(dest));
	}

	async copy(src: string, dest: string) {
		await this.client.copyFile(this.fullPath(src), this.fullPath(dest));
	}

	async write(filepath: string, content: Readable) {
		const remotePath = this.fullPath(filepath);
		await this.client.putFileContents(remotePath, content);
	}

	async delete(filepath: string) {
		await this.client.deleteFile(this.fullPath(filepath));
	}

	async *list(prefix = ''): AsyncGenerator<string> {
		const remotePrefix = this.fullPath(prefix);
		const res = await this.client.getDirectoryContents(remotePrefix, { deep: true });

		// Unwrap data if needed
		const contents = 'data' in res ? res.data : res;

		for (const item of contents) {
			if (item.type === 'file' && typeof item.filename === 'string') {
				const relativePath = relative(this.root, item.filename);
				yield relativePath.replace(/^\/+/, '');
			}
		}
	}
	get tusExtensions() {
		return ['creation', 'termination', 'expiration'];
	}

	async createChunkedUpload(filepath: string, context: ChunkedUploadContext): Promise<ChunkedUploadContext> {
		// Wrap empty buffer in a readable stream
		const emptyStream = Readable.from(Buffer.alloc(0));
		await this.write(filepath, emptyStream);
		return context;
	}

	async writeChunk(
		filepath: string,
		content: Readable,
		offset: number,
		_context: ChunkedUploadContext
	): Promise<number> {
		const remotePath = this.fullPath(filepath);
		const existing = await this.client.getFileContents(remotePath, { format: 'binary' });

		const existingRaw = (typeof existing === 'object' && existing !== null && 'data' in existing)
			? existing.data
			: existing;

		let existingBuffer: Buffer;

		if (typeof existingRaw === 'string') {
			existingBuffer = Buffer.from(existingRaw);
		} else if (existingRaw instanceof ArrayBuffer) {
			existingBuffer = Buffer.from(new Uint8Array(existingRaw));
		} else {
			existingBuffer = existingRaw as unknown as Buffer;
		}

		const chunks: Buffer[] = [];
		for await (const chunk of content) {
			chunks.push(Buffer.from(chunk));
		}

		const newContent = Buffer.concat([
			existingBuffer.subarray(0, offset),
			...chunks,
		]);

		await this.client.putFileContents(remotePath, newContent);

		return newContent.length;
	}

	async deleteChunkedUpload(filepath: string, _context: ChunkedUploadContext): Promise<void> {
		await this.delete(filepath);
	}

	async finishChunkedUpload(_filepath: string, _context: ChunkedUploadContext): Promise<void> {
		// WebDAV doesn't require a finalization step
	}
}

export default DriverWebDAV;