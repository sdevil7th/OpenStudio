// JUCE wildcard filters, shared by menus and command actions. Project dialogs
// deliberately keep their native default (*.osproj).
export const AUDIO_FILE_FILTER = "*.wav;*.aiff;*.aif;*.flac;*.ogg;*.mp3";
export const VIDEO_FILE_FILTER = "*.mp4;*.mov;*.m4v;*.avi;*.mkv;*.webm;*.mpeg;*.mpg";
export const MEDIA_FILE_FILTER = `${AUDIO_FILE_FILTER};${VIDEO_FILE_FILTER}`;
