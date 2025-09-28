"use strict";

// --- DOM Elements ---
const selectRomFolderBtn = document.getElementById('select-rom-folder');
const selectImageFolderBtn = document.getElementById('select-image-folder');
const romFolderPathSpan = document.getElementById('rom-folder-path');
const imageFolderPathSpan = document.getElementById('image-folder-path');
const scanButton = document.getElementById('scan-button');
const deleteButton = document.getElementById('delete-button');
const resultsContainer = document.getElementById('results-container');
const statusBar = document.getElementById('status-bar');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');

// --- Configuration ---
const MULTI_PART_PATTERNS = [
    // Original patterns for content in brackets
    /\(disc\s*\d+\)/i,
    /\(disk\s*\d+\)/i,
    /\(side\s*[AB\d]+\)/i,
    /\(part\s*\d+\)/i,
    /\(cart\s*\d+\)/i,
    /\(tape\s*\d+\)/i,
    /\(book\s*\d+\)/i,
    /\(mission\s*disk\)/i,

    // New, more flexible patterns for content NOT necessarily in brackets
    // This covers "Mission Disk Vol. 1", "Scenery Disk 7", "Disk 2 of 4", etc.
    /(?:disc|disk|part|vol|volume|side|scenery disk)\s*[\dIVX]+/i
];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp'];

// --- Application Status ---
let romDirHandle = null;
let imageDirHandle = null;
let duplicateGroups = {};

// --- Event Listeners ---
selectRomFolderBtn.addEventListener('click', async () => {
    try {
        romDirHandle = await window.showDirectoryPicker({
            id: 'roms',
            mode: 'readwrite'
        });
        romFolderPathSpan.textContent = romDirHandle.name;
        updateButtonStates();
        updateStatus(`ROM folder selected: ${romDirHandle.name}`);
    } catch (err) {
        if (err.name !== 'AbortError') {
            updateStatus(`Error selecting ROM folder: ${err.message}`, true);
        }
    }
});

selectImageFolderBtn.addEventListener('click', async () => {
    try {
        imageDirHandle = await window.showDirectoryPicker({
            id: 'images',
            mode: 'readwrite'
        });
        imageFolderPathSpan.textContent = imageDirHandle.name;
        updateButtonStates();
        updateStatus(`Image folder selected: ${imageDirHandle.name}`);
    } catch (err) {
        if (err.name !== 'AbortError') {
            updateStatus(`Error selecting image folder: ${err.message}`, true);
        }
    }
});

scanButton.addEventListener('click', scanForDuplicates);
deleteButton.addEventListener('click', deleteSelectedFiles);


// --- Core Logic ---

function isMultiPart(filename) {
    return MULTI_PART_PATTERNS.some(pattern => pattern.test(filename));
}

function getBaseName(filename) {
    // Start with the filename, remove extension as it's not relevant for the base name
    let name = filename.lastIndexOf('.') > 0 ? filename.substring(0, filename.lastIndexOf('.')) : filename;

    // Rule 1: Remove all content in brackets () and []
    // This gets rid of (USA), (Europe), [b1], etc.
    name = name.replace(/\s*[\(\[].*?[\)\]]/g, '');

    // Rule 2: Take only text before the first '+' (for compilations)
    name = name.split('+')[0];

    // Rule 3: Normalize sequels (remove Roman/Arabic numerals at the end)
    // This is only applied if the title is complex (contains a separator AND is long enough) 
    // to avoid false positives like 'Turrican 3' or 'R-Type II'.
    if ((name.includes('-') || name.includes(':')) && name.length > 15) {
        name = name.replace(/\s+(?:\d+|I|II|III|IV|V|VI|VII|VIII)$/i, '');
    }

    // Rule 4: Final cleanup of trailing characters and whitespace
    name = name.replace(/[\s-_]+$/, '').trim();

    // Return in lowercase for case-insensitive comparison
    return name.toLowerCase();
}

async function scanForDuplicates() {
    if (!romDirHandle) {
        updateStatus("Error: No ROM folder selected.", true);
        return;
    }
    updateStatus("Scan in progress... Please wait.");
    scanButton.disabled = true;
    deleteButton.disabled = true;

    const potentialDuplicates = new Map();
    try {
        for await (const entry of romDirHandle.values()) {
            if (entry.kind !== 'file') continue; // Ignore subdirectories

            if (isMultiPart(entry.name)) {
                console.log(`Ignoring multi-part set: ${entry.name}`);
                continue;
            }

            const baseName = getBaseName(entry.name);
            console.log(`File: ${entry.name} -> Base: ${baseName}`); // Diagnostic log
            if (baseName) {
                if (!potentialDuplicates.has(baseName)) {
                    potentialDuplicates.set(baseName, []);
                }
                potentialDuplicates.get(baseName).push(entry.name);
            }
        }
    } catch (err) {
        updateStatus(`Error scanning folder: ${err.message}`, true);
        scanButton.disabled = false;
        return;
    }

    duplicateGroups = {};
    for (const [base, files] of potentialDuplicates.entries()) {
        if (files.length > 1) {
            duplicateGroups[base] = files.sort();
        }
    }

    await displayResults();
    updateButtonStates();
}

async function displayResults() {
    resultsContainer.innerHTML = ''; // Clear previous results
    const groupKeys = Object.keys(duplicateGroups);

    if (groupKeys.length === 0) {
        resultsContainer.innerHTML = '<p>No duplicates found according to the rules.</p>';
        updateStatus("Scan complete. No duplicates found.");
        return;
    }

    const groupCount = groupKeys.length;
    const fileCount = Object.values(duplicateGroups).reduce((sum, files) => sum + files.length, 0);
    updateStatus(`Scan complete. Found ${groupCount} duplicate groups with a total of ${fileCount} files.`);

    const resultsList = document.createElement('ul');
    
    // Sort groups by base name
    for (const baseName of groupKeys.sort()) {
        const files = duplicateGroups[baseName];
        
        const groupHeader = document.createElement('li');
        groupHeader.className = 'group-header';
        
        const imagePreviewContainer = document.createElement('div');
        imagePreviewContainer.className = 'image-preview-container';
        groupHeader.appendChild(imagePreviewContainer);

        const groupTitle = document.createElement('span');
        groupTitle.textContent = `Group: ${baseName} (${files.length} files)`;
        groupHeader.appendChild(groupTitle);

        resultsList.appendChild(groupHeader);

        // Find and display the first available image for the group
        if (imageDirHandle) {
            let imageFound = false;
            for (const file of files) {
                if (imageFound) break;
                const baseFilename = file.substring(0, file.lastIndexOf('.'));
                for (const ext of IMAGE_EXTENSIONS) {
                    const imgFilename = baseFilename + ext;
                    try {
                        const fileHandle = await imageDirHandle.getFileHandle(imgFilename);
                        const imgFile = await fileHandle.getFile();
                        const img = document.createElement('img');
                        img.src = URL.createObjectURL(imgFile);
                        img.onload = () => URL.revokeObjectURL(img.src); // Important: Free up memory
                        img.title = imgFilename;
                        imagePreviewContainer.appendChild(img);
                        imageFound = true;
                        break; // Only one image per group
                    } catch (e) {
                        if (e.name !== 'NotFoundError') {
                            console.warn(`Could not load image: ${imgFilename}`, e);
                        }
                    }
                }
            }
        }


        files.forEach((file, index) => {
            const fileItem = document.createElement('li');
            fileItem.className = 'file-item';
            fileItem.dataset.group = baseName;
            fileItem.dataset.filename = file;

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = `group-${baseName}`;
            radio.value = file;
            radio.id = `radio-${file}`;
            if (index === 0) { // Select first file by default
                radio.checked = true;
            }

            const label = document.createElement('label');
            label.htmlFor = `radio-${file}`;
            label.textContent = file;

            fileItem.appendChild(radio);
            fileItem.appendChild(label);
            resultsList.appendChild(fileItem);

            radio.addEventListener('change', () => {
                updateVisualSelection(baseName);
            });
        });
    }

    resultsContainer.appendChild(resultsList);

    // Apply initial styling for all groups AFTER the list is in the DOM
    groupKeys.forEach(baseName => {
        updateVisualSelection(baseName);
    });
}

async function deleteSelectedFiles() {
    if (!romDirHandle || !imageDirHandle) {
        updateStatus("Error: ROM and Image folders must be selected.", true);
        return;
    }

    const filesToDelete = [];
    for (const baseName in duplicateGroups) {
        const selectedFile = document.querySelector(`input[name="group-${baseName}"]:checked`).value;
        duplicateGroups[baseName].forEach(file => {
            if (file !== selectedFile) {
                filesToDelete.push(file);
            }
        });
    }

    if (filesToDelete.length === 0) {
        updateStatus("No files selected for deletion.", false);
        return;
    }

    const confirmation = confirm(
        `You are about to delete ${filesToDelete.length} files (and their images) marked as redundant. The files marked in green will be kept.\n\nContinue?\n\n${filesToDelete.slice(0, 10).join('\n')}${filesToDelete.length > 10 ? '\n...' : ''}`
    );

    if (!confirmation) {
        updateStatus("Deletion process canceled.");
        return;
    }

    updateStatus(`Deleting ${filesToDelete.length} files...`);
    deleteButton.disabled = true;
    scanButton.disabled = true; // Disable scan button during deletion
    progressContainer.classList.remove('hidden');
    progressBar.style.width = '0%';

    let deletedCount = 0;
    let errorCount = 0;
    const totalFiles = filesToDelete.length;

    for (let i = 0; i < totalFiles; i++) {
        const filename = filesToDelete[i];
        try {
            // Delete ROM
            await romDirHandle.removeEntry(filename);
            console.log(`Deleted: ${filename} in ROM folder`);
            deletedCount++;

            // Delete associated image (try)
            const baseFilename = filename.substring(0, filename.lastIndexOf('.'));
            for (const ext of IMAGE_EXTENSIONS) {
                try {
                    await imageDirHandle.removeEntry(baseFilename + ext);
                    console.log(`Deleted: ${baseFilename + ext} in image folder`);
                } catch (imgErr) {
                    if (imgErr.name !== 'NotFoundError') throw imgErr;
                }
            }
        } catch (err) {
            console.error(`Error deleting ${filename}: ${err.message}`);
            errorCount++;
        }

        // Update progress and force UI update
        const progress = ((i + 1) / totalFiles) * 100;
        progressBar.style.width = `${progress}%`;
        
        // Short pause to allow the browser to redraw the UI
        if (i % 10 === 0) { // Not for every file, to avoid slowing it down
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    // Short delay to show 100%
    await new Promise(resolve => setTimeout(resolve, 200));
    progressContainer.classList.add('hidden');

    let finalMsg = `Deletion complete. ${deletedCount} ROM files deleted.`;
    if (errorCount > 0) {
        finalMsg += ` ${errorCount} errors occurred (see console for details).`;
    }
    updateStatus(finalMsg);

    // Short pause before rescan so the status message is visible
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Rescan to show the updated state
    await scanForDuplicates();

    // Final status message after successful deletion
    if (errorCount === 0) {
        updateStatus("Deletion successful. No more duplicates found. You can select new folders.");
    }
}


// --- Helper Functions ---

function updateButtonStates() {
    const bothFoldersSelected = romDirHandle && imageDirHandle;
    scanButton.disabled = !bothFoldersSelected;
    deleteButton.disabled = Object.keys(duplicateGroups).length === 0 || !bothFoldersSelected;
}

function updateStatus(message, isError = false) {
    statusBar.textContent = message;
    statusBar.style.color = isError ? '#c53030' : '#2d3748';
    statusBar.style.backgroundColor = isError ? '#fed7d7' : '#f7fafc';
    console.log(message);
}

function updateVisualSelection(baseName) {
    const fileItems = document.querySelectorAll(`.file-item[data-group="${baseName}"]`);
    fileItems.forEach(item => {
        const radio = item.querySelector('input[type="radio"]');
        if (radio.checked) {
            item.classList.add('file-to-keep');
            item.classList.remove('file-to-delete');
        } else {
            item.classList.add('file-to-delete');
            item.classList.remove('file-to-keep');
        }
    });
}

// --- Initialization ---
updateStatus("Ready. Please select the ROM and Image folders.");