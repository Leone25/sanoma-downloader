import yargs from 'yargs';
import PromptSync from 'prompt-sync';
import fetch from 'node-fetch';
import yauzl from 'yauzl';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import fsExtra from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream';

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

const yauzlFromFile = promisify(yauzl.open);

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

		book = await fetch(`https://npmoffline.sanoma.it/mcs/users/${id}/products/books/${gedi}?app=true`, {
			headers: {
				'X-Auth-Token': 'Bearer ' + userAuth.result.data.access_token,
			}
		}).then((res) => res.json());

		if (book.code != 0) {
			console.error('Failed to fetch book data', book.message);
			process.exit(1);
		}

		book = book.result.data;

		console.log('Downloading "' + book.name + '"');

		let zip = await fetch(book.url_download);

		if (!zip.ok) {
			console.error('Failed to download zip');
			process.exit(1);
		}

		await promisify(pipeline)(zip.body, fs.createWriteStream('tmp/book.zip'));
	} else {
		console.log('Skipping download');
		let stats = await fs.promises.stat('tmp/book.zip');
		if (!stats.isFile()) {
			console.error('No zip file found in the tmp folder');
			process.exit(1);
		}
	}

	console.log('Extracting zip');

	let zipFile = await yauzlFromFile('tmp/book.zip');
	let openReadStream = promisify(zipFile.openReadStream.bind(zipFile));

	zipFile.on('entry', async (entry) => {
		if (!entry.fileName.startsWith("assets/book/pages") || entry.fileName.endsWith('/')) return;

		let filePath = entry.fileName.slice(18);

		console.log('Extracting ' + filePath);

		let folder = path.dirname(filePath);
		await fsExtra.ensureDir(`tmp/pages/${folder}`);

		let page = await openReadStream(entry);

		let file = fs.createWriteStream(`tmp/pages/${filePath}`);
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
			let file = await fs.promises.readFile(`tmp/output/${i+1}.pdf`);
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