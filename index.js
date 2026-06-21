import yargs from 'yargs';
import PromptSync from 'prompt-sync';
import fetch from 'node-fetch';
import unzipper from 'unzipper';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import fsExtra from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';

const argv = yargs(process.argv)
	.option('id', {
		alias: 'i',
		type: 'string',
		description: 'user id (email)',
	})
	.option('password', {
		alias: 'p',
		type: 'string',
		description: 'user password',
	})
	.option('gedi', {
		alias: 'g',
		type: 'string',
		description: 'book\'s gedi',
	})
	.option('output', {
		alias: 'o',
		type: 'string',
		description: 'Output file',
	})
	.option('download', {
		type: 'boolean',
		description: 'Download the book',
		default: true,
		hidden: true,
	})
	.option('no-download', {
		type: 'boolean',
		description: 'Skip downloading the book and try to extract the zip file that is already in the temp folder',
		default: false,
	})
	.option('clean', {
		type: 'boolean',
		description: 'Clean up the temp folder after finishing',
		default: true,
		hidden: true,
	})
	.option('no-clean', {
		type: 'boolean',
		description: 'Don\'t clean up the temp folder after finishing',
		default: false,
	})
	.help()
	.argv;

const prompt = PromptSync({ sigint: true });

(async () => {

	await fsExtra.ensureDir('tmp');

	let book;

	if (argv.download) {

		let folder = await fs.promises.readdir('tmp');
		if (folder.length > 0) {
			console.log('Temp folder is not empty, make sure to delete the tmp folder if you want to download the book');
			process.exit(1);
		}

		let id = argv.id;
		let password = argv.password;

		console.log('Warning: this script might log you out of your other devices');

		while (!id)
			id = prompt('Enter account email: ');

		while (!password)
			password = prompt('Enter account password: ');

		let userAuth = await fetch('https://npmoffline.sanoma.it/mcs/api/v1/login', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Timezone-Offset': '+0200', // this is required for whatever reason
			},
			body: JSON.stringify({
				id: id,
				password: password,
			}),
		}).then((res) => res.json()).catch((err) => {
			console.error('Failed to log in');
			process.exit(1);
		});

		if (userAuth.code != 0) {
			console.error('Failed to log in', userAuth.message);
			process.exit(1);
		}

		await fetch(`https://npmoffline.sanoma.it/mcs/users/${id}/products/`, {
			headers: {
				'X-Auth-Token': 'Bearer ' + userAuth.result.data.access_token,
			}
		})
		console.log('Fetching book list');
		let books = {};
		let pages = 1;
		for (let i = 1; i <= pages; i++) {
			let newBooks = await fetch(`https://npmoffline.sanoma.it/mcs/api/v1/books?app=true`, {
				headers: {
					'X-Auth-Token': 'Bearer ' + userAuth.result.data.access_token,
				}
			}).then((res) => res.json());

			pages = newBooks.result.total_size / newBooks.result.page_size;

			for (let book of newBooks.result.data) {
				books[book.gedi] = book;
			}
		}

		console.log('Books:');
		console.table(Object.fromEntries(Object.entries(books).map(([id, book]) => [id, book.name])));

		let gedi = argv.gedi;
		while (!gedi)
			gedi = prompt('Enter the book\'s gedi: ');

		book = books[gedi];

		console.log('Downloading "' + book.name + '"');

		let zip = await fetch(book.url_download);

		if (!zip.ok) {
			console.error('Failed to download zip');
			process.exit(1);
		}

		await fs.promises.writeFile("tmp/book.zip", Buffer.from(await zip.arrayBuffer()));
	} else {
		console.log('Skipping download');
		let stats = await fs.promises.stat('tmp/book.zip');
		if (!stats.isFile()) {
			console.error('No zip file found in the tmp folder');
			process.exit(1);
		}
	}

	console.log('Extracting zip');

	let zipFile = fs
		.createReadStream('tmp/book.zip')
		.pipe(unzipper.Parse({forceStream: true}));

	for await (let entry of zipFile) {
		if (!entry.path.startsWith("pages") || entry.path.endsWith("/")) {
			entry.autodrain();
			continue;
		}

		const filePath = entry.path.slice(5);

		console.log(`Extracting ${filePath}`);

		let folder = path.dirname(filePath);
		await fsExtra.ensureDir(`tmp/pages/${folder}`);

		await new Promise((resolve, reject) => {
			const writeStream = fs.createWriteStream(`tmp/pages/${filePath}`);
			writeStream.on("finish", resolve);
			writeStream.on("error", reject);

			entry.on("error", reject);
			entry.pipe(writeStream);
		});
	}

	await fs.promises.mkdir('tmp/output', { recursive: true });
	let folders = (await fs.promises.readdir('tmp/pages')).filter((file) => /^\d+$/g.test(file));

	let total = folders.length;

	for (let i = 0; i < total; i++) {
		console.log(`Converting page ${i + 1} of ${total}`);
		await convertPage(`tmp/pages/${i+1}/${i+1}.svg`, `tmp/output/${i+1}.pdf`);
	}

	console.log('Merging pages');

	let pdf = await PDFDocument.create();

	for (let i = 0; i < total; i++) {
		let file = await fs.promises.readFile(`tmp/output/${i + 1}.pdf`);
		let page = await PDFDocument.load(file);
		let [copiedPage] = await pdf.copyPages(page, [0]);
		pdf.addPage(copiedPage);
	}

	console.log('Saving PDF');

	let name = argv.output;
	if (argv.download && !name) {
		name = book.name.replace(/[\\/:*?"<>|]/g, '') + '.pdf';
	} else if (!name) {
		name = 'output.pdf';
	}

	await fs.promises.writeFile(name, await pdf.save());

	if (argv.clean) {
		console.log('Cleaning up');

		await fsExtra.remove('tmp');
	} else {
		console.log('Skipping clean up, make sure to delete the temp folder when you are done');
	}

	console.log('Done');
})();

let inkscapeVersion; // old = 0.92 or older, new = anything after

async function getInkscapeVersion() {
	return new Promise((resolve, reject) => {
		let convert = spawn('inkscape', ['--version']);

		convert.stdout.on("data", data => {
			const version = data.toString();
			const [_, major, minor ] = version.match(/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/);
			if (major == 0 && minor <= 92) inkscapeVersion = "old";
			else inkscapeVersion = "new";
			resolve();
		});
	});
}

async function convertPage(input, output) {
	return new Promise(async (resolve, reject) => {
		if (!inkscapeVersion) await getInkscapeVersion();

		let convert = spawn('inkscape', [(inkscapeVersion == "old" ? '--export-pdf=' : '--export-filename=') +output, input]);

		convert.on('close', (code) => {
			if (code == 0) resolve();
			else reject(code);
		});
	});
}