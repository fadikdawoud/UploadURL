const imageInput = document.getElementById("imageInput");
const cardContainer = document.querySelector(".section");
const dropArea = document.getElementById("dropArea");
let files = [];
let currentPreviewIndex = -1; // Track current image index in preview mode

// Load images from local storage on page load
window.onload = () => {
    const savedFiles = JSON.parse(localStorage.getItem("images"));
    if (savedFiles && Array.isArray(savedFiles)) {
        files = savedFiles;
        showImages();
    }
};

// Handle paste event
document.addEventListener("paste", (e) => {
    const items = e.clipboardData.items;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item.type.indexOf("image") !== -1) {
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = (event) => {
                files.push(event.target.result);
                showImages();
                saveToLocalStorage();
            };
            reader.readAsDataURL(blob);
        }
    }
});

// Drag and drop event listeners
dropArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropArea.classList.add("dragover");
});

dropArea.addEventListener("dragleave", () => {
    dropArea.classList.remove("dragover");
});

dropArea.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropArea.classList.remove("dragover");

    // Check if the dropped item is a file or a URL
    if (e.dataTransfer.files.length > 0) {
        const droppedFiles = e.dataTransfer.files;
        handleDroppedFiles(droppedFiles);
    } else if (e.dataTransfer.types.includes("text/uri-list")) {
        const droppedUrl = e.dataTransfer.getData("text/uri-list");

        // Check if the URL points to an image or YouTube video or is a generic link
        if (isImageUrl(droppedUrl)) {
            handleDroppedUrl(droppedUrl);
        } else if (isYouTubeUrl(droppedUrl)) {
            handleYouTubeUrl(droppedUrl);
        } else {
            handleGenericLink(droppedUrl);
        }
    }
});

imageInput.addEventListener("change", () => {
    const selectedFiles = imageInput.files;
    handleDroppedFiles(selectedFiles);
});

const handleDroppedFiles = (fileList) => {
    for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        
        // Check if the file is a gif before reading it as data URL
        if (file.type.toLowerCase().includes('gif') ) {
            const reader = new FileReader();
            reader.onload = (event) => {
                const fileUrl = event.target.result;

                // Add the gif as a gif-player object
                files.push({ src: fileUrl, type: "gif" });

                showImages();
                saveToLocalStorage();
            };
            reader.readAsDataURL(file);
        } else {
            // If it's not a gif, just add it as a regular image URL
            const reader = new FileReader();
            reader.onload = (event) => {
                const fileUrl = event.target.result;

                // Add regular image
                files.push(fileUrl);

                showImages();
                saveToLocalStorage();
            };
            reader.readAsDataURL(file);
        }
    }
};

const handleDroppedUrl = async (url) => {
    // if (url.toLowerCase().endsWith('.webp')) {
    //     // Replace .webp with .gif in the URL
    //     url = url.replace(/\.webp$/, '.gif');
    // }

    if (url.toLowerCase().endsWith('.gif')) {
        // Treat as a gif-player
        files.push({ src: url, type: "gif" });
        showImages();
        saveToLocalStorage();
    } else {
        // Treat as a regular image
        files.push(url);
        showImages();
        saveToLocalStorage();
    }
    
    if (isYouTubeUrl(url)) {
        // If the URL is a YouTube link, treat it as a YouTube video
        handleYouTubeUrl(url);
        showImages();
        saveToLocalStorage();
    } else if (isImageUrl(url)) {
        // If the URL points to an image
        files.push(url);
        showImages();
        saveToLocalStorage();
    } else {
        // Otherwise, treat it as a generic link
        handleGenericLink(url);
        showImages();
        saveToLocalStorage();
    }

    // showImages();
    // saveToLocalStorage();
};



const handleYouTubeUrl = async (url) => {
    const videoId = getYouTubeVideoId(url);
    if (videoId) {
        const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        const videoData = {
            type: "youtube",
            url: url,
            thumbnail: thumbnailUrl
        };
        files.push(videoData);
        showImages();
        saveToLocalStorage();
    } else {
        console.error("Invalid YouTube URL.");
    }
};


const handleGenericLink = async (url) => {
    const linkData = {
        type: "link",
        url: url
    };
    files.push(linkData);
    showImages();
    saveToLocalStorage();
};

const isImageUrl = (url) => {
    return url.toLowerCase().match(/\.(jpeg|jpg|gif|png|webp)$/) !== null;
};

const isYouTubeUrl = (url) => {
    const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
    return pattern.test(url);
};

const getYouTubeVideoId = (url) => {
    const match = url.match(/[?&]v=([^&#]*)|youtu\.be\/([^&#]*)/);
    return match ? match[1] || match[2] : null;
};

// Updated showImages function
const showImages = () => {
    let images = "";

    files.forEach((e, i) => {
        if (typeof e === "string") { // Regular image
            const imgTag = e.toLowerCase().endsWith(".gif") 
                ? `<gif-player src="${e}" class="imglook" id="gif-${i}" speed="1"></gif-player>` 
                : `<img class="imglook" src="${e}" id="img-${i}">`;

            images += `
                <div class="hidden">
                    <div class="holder">
                        ${imgTag}
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        } else if (e.type === "gif") { // GIF player
            images += `
                <div class="hidden">
                    <div class="holder">
                        <gif-player src="${e.src}" class="imglook" id="gif-${i}"></gif-player>
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        } else if (e.type === "youtube") { // YouTube video thumbnail
            images += `
                <div class="hidden">
                    <div class="holder">
                        <a href="${e.url}" target="_blank">
                            <img src="${e.thumbnail}" alt="YouTube Video">
                        </a>
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        } else if (e.type === "link") { // Generic link
            images += `
                <div class="hidden">
                    <div class="holder link-holder">
                        <a href="${e.url}" target="_blank" class="link-box">${e.url}</a>
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        }
    });

    cardContainer.innerHTML = images;
    observeHiddenElements();

    document.querySelectorAll(".holder img, .holder gif-player").forEach(thisOne => {
        const parentHolder = thisOne.closest(".holder");
        const isYouTube = parentHolder.querySelector("a") && parentHolder.querySelector("a[href*='youtube']");

        if (!isYouTube) { // Prevent adding PopUpPreview for YouTube links
            thisOne.onclick = () => {
                // Find the index of this image in the files array
                const imageId = thisOne.id;
                const indexMatch = imageId.match(/\d+/);
                currentPreviewIndex = indexMatch ? parseInt(indexMatch[0]) : 0;
                
                showPreview(currentPreviewIndex);
            };
        }
    });
};

// Function to show preview for a specific index
const showPreview = (index) => {
    if (index < 0 || index >= files.length) return;
    
    const file = files[index];
    const previewContainer = document.querySelector(".PopUpPreview");
    previewContainer.style.display = "block";
    
    let previewContent = '';
    
    if (typeof file === "string") {
        if (file.toLowerCase().endsWith(".gif")) {
            previewContent = `
                <span>&#10006;</span>
                <gif-player src="${file}" class="popup-gif"></gif-player>
            `;
        } else {
            previewContent = `
                <span>&#10006;</span>
                <img src="${file}" alt="Preview">
            `;
        }
    } else if (file.type === "gif") {
        previewContent = `
            <span>&#10006;</span>
            <gif-player src="${file.src}" class="popup-gif"></gif-player>
        `;
    } else if (file.type === "youtube") {
        previewContent = `
            <span>&#10006;</span>
            <a href="${file.url}" target="_blank">
                <img src="${file.thumbnail}" alt="YouTube Video Preview">
            </a>
        `;
    } else if (file.type === "link") {
        previewContent = `
            <span>&#10006;</span>
            <div class="link-preview">
                <a href="${file.url}" target="_blank" class="link-box">${file.url}</a>
            </div>
        `;
    }
    
    previewContainer.innerHTML = previewContent;
    
    // Add close button functionality
    const closeBtn = document.querySelector(".PopUpPreview span");
    if (closeBtn) {
        closeBtn.onclick = () => {
            previewContainer.style.display = "none";
            currentPreviewIndex = -1;
        };
    }
};

// Function to navigate to previous image
const showPreviousImage = () => {
    if (currentPreviewIndex > 0) {
        currentPreviewIndex--;
        showPreview(currentPreviewIndex);
    }
};

// Function to navigate to next image
const showNextImage = () => {
    if (currentPreviewIndex < files.length - 1) {
        currentPreviewIndex++;
        showPreview(currentPreviewIndex);
    }
};

// Enhanced keyboard event handling
document.addEventListener("keydown", (e) => {
    const previewContainer = document.querySelector(".PopUpPreview");
    const isPreviewVisible = previewContainer.style.display === "block";
    
    if (isPreviewVisible) {
        switch(e.key) {
            case "Escape":
                previewContainer.style.display = "none";
                currentPreviewIndex = -1;
                break;
            case "ArrowLeft":
                e.preventDefault();
                showPreviousImage();
                break;
            case "ArrowRight":
                e.preventDefault();
                showNextImage();
                break;
        }
    }
});


const deleteImage = (index) => {
    files.splice(index, 1);
    showImages();
    saveToLocalStorage();
};

const observeHiddenElements = () => {
    const hiddenElements = document.querySelectorAll('.hidden');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add('showx');
            } else {
                entry.target.classList.remove('showx');
            }
        });
    });

    hiddenElements.forEach((element) => {
        observer.observe(element);
    });
};

const saveToLocalStorage = () => {
    console.log("Saving files:", files); // Debug
    localStorage.setItem("images", JSON.stringify(files));
};

// Save images to local storage before the page unloads
window.addEventListener("beforeunload", saveToLocalStorage);

// Initial call to showImages to load any pre-existing images
showImages();

const handleKeyPress = (event) => {
    if (event.key === "Enter") {
        addImageUrl();
    }
};
const addImageUrl = () => {
    const imageUrlInput = document.getElementById("imageUrlInput");
    const imageUrl = imageUrlInput.value.trim();

    if (imageUrl !== "") {
        if (isYouTubeUrl(imageUrl)) {
            handleYouTubeUrl(imageUrl);
        } else if (isImageUrl(imageUrl)) {
            handleDroppedUrl(imageUrl);
        } else {
            handleGenericLink(imageUrl);
        }
        imageUrlInput.value = "";
    }
};

const clearButton = document.getElementById("clearButton");
const clearDatabaseAndFiles = () => {
    if (confirm("Are you sure you want to delete all images?")) {
        files = [];
        showImages();
        localStorage.removeItem("images");
    }
};
clearButton.addEventListener("click", clearDatabaseAndFiles);

