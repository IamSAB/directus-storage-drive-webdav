import type { Driver, ReadOptions } from '@directus/storage';
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

export class DriverWebDAV implements Driver {
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
}

export default DriverWebDAV;