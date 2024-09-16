import yargs from 'yargs';
import PromptSync from 'prompt-sync';
import fetch from 'node-fetch';
import yauzl from 'yauzl';
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
	.help()
	.argv;

const prompt = PromptSync({ sigint: true });

function promisify(api) {
	return function (...args) {
		return new Promise(function (resolve, reject) {
			api(...args, function (err, response) {
				if (err) return reject(err);
				resolve(response);
			});
		});
	};
}

const yauzlFromBuffer = promisify(yauzl.fromBuffer);

(async () => {
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

	let gedi = argv.gedi;

	await fetch(`https://npmoffline.sanoma.it/mcs/users/${id}/products/`, {
		headers: {
			'X-Auth-Token': 'Bearer ' + userAuth.result.data.access_token,
		}
	})

	if (!gedi) {
		console.log('Fetching book list');
		let books = {};
		let pages = 1;
		for (let i = 1; i <= pages; i++) {
			let newBooks = await fetch(`https://npmoffline.sanoma.it/mcs/users/${id}/products/books/`, {
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

		while (!gedi)
			gedi = prompt('Enter the book\'s gedi: ');
	}

	console.log('Fetching book data');

	let book = await fetch(`https://npmoffline.sanoma.it/mcs/users/${id}/products/books/${gedi}?app=true`, {
		headers: {
			'X-Auth-Token': 'Bearer ' + userAuth.result.data.access_token,
		}
	}).then((res) => res.json());

	if (book.code != 0) {
		console.error('Failed to fetch book data', book.message);
		process.exit(1);
	}

	book = book.result.data;

	console.log('Downloading ' + book.name);

	let zip = await fetch(book.url_download).then((res) => res.arrayBuffer());

	await fsExtra.ensureDir('tmp');

	console.log('Extracting zip');

	let zipFile = await yauzlFromBuffer(Buffer.from(zip));
	let openReadStream = promisify(zipFile.openReadStream.bind(zipFile));

	zipFile.on('entry', async (entry) => {
		if (!entry.fileName.startsWith("pages") || entry.fileName.endsWith('/')) return;

		console.log('Extracting ' + entry.fileName);

		let folder = path.dirname(entry.fileName);
		await fsExtra.ensureDir(`tmp/${folder}`);

		let page = await openReadStream(entry);

		let file = fs.createWriteStream(`tmp/${entry.fileName}`);
		page.pipe(file);
	});

	zipFile.on('end', async () => {
		await fs.promises.mkdir('tmp/output', { recursive: true });
		let folders = (await fs.promises.readdir('tmp/pages')).filter((file) => /^\d+$/g.test(file));

		let total = folders.length;

		for (let i = 0; i < total; i++) {
			console.log('Converting page ' + (i + 1) + ' of ' + total);
			await convertPage(`tmp/pages/${i+1}/${i+1}.svg`, `tmp/output/${i+1}.pdf`);
		}

		console.log('Merging pages');

		let pdf = await PDFDocument.create();
		
		for (let i = 0; i < total; i++) {
			let page = await PDFDocument.load(fs.readFileSync(`tmp/output/${i+1}.pdf`));
			let [copiedPage] = await pdf.copyPages(page, [0]);
			pdf.addPage(copiedPage);
		}

		console.log('Saving PDF');

		await fs.promises.writeFile(argv.output || book.name.replace(/[\\/:*?"<>|]/g, '') + '.pdf', await pdf.save());

		console.log('Cleaning up');

		await fsExtra.remove('tmp');

		console.log('Done');
	});
})();

async function convertPage(input, output) {
	return new Promise((resolve, reject) => {
		let convert = spawn('inkscape', ['--export-filename='+output, input]);

		convert.on('close', (code) => {
			if (code == 0) resolve();
			else reject(code);
		});
	});
}