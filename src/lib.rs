use std::{
    env,
    path::{Path, PathBuf},
};

use zed_extension_api::settings::LspSettings;
use zed_extension_api::{self as zed, serde_json, Result};

const LANGUAGE_SERVER_ID: &str = "texpresso-live";
const ADAPTER_RELEASE_TAG: &str = "adapter-v0.1.2";
const ADAPTER_FILE_NAME: &str = "texpresso-live-adapter-v0.1.2.mjs";
const ADAPTER_RELEASE_URL: &str = "https://github.com/Maymall/texpresso-zed/releases/download/adapter-v0.1.2/texpresso-live-server.mjs";

#[derive(Default)]
struct TeXpressoExtension;

fn extension_directory() -> Result<PathBuf> {
    env::current_dir().map_err(|error| {
        format!(
            "TeXpresso could not determine its extension directory: {error}. Reinstall the dev extension."
        )
    })
}

fn adapter_path_in(work_directory: &Path) -> PathBuf {
    work_directory.join(ADAPTER_FILE_NAME)
}

fn adapter_path() -> Result<PathBuf> {
    // Zed gives extensions a writable work directory, not the source checkout.
    Ok(adapter_path_in(&extension_directory()?))
}

fn install_adapter(language_server_id: &zed::LanguageServerId) -> Result<PathBuf> {
    let server_path = adapter_path()?;
    if server_path.is_file() {
        return Ok(server_path);
    }

    zed::set_language_server_installation_status(
        language_server_id,
        &zed::LanguageServerInstallationStatus::CheckingForUpdate,
    );
    zed::set_language_server_installation_status(
        language_server_id,
        &zed::LanguageServerInstallationStatus::Downloading,
    );

    if let Err(error) = zed::download_file(
        ADAPTER_RELEASE_URL,
        ADAPTER_FILE_NAME,
        zed::DownloadedFileType::Uncompressed,
    ) {
        let message = format!(
            "TeXpresso could not download adapter {ADAPTER_RELEASE_TAG} from {ADAPTER_RELEASE_URL}: {error}"
        );
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::Failed(message.clone()),
        );
        return Err(message);
    }

    if server_path.is_file() {
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::None,
        );
        Ok(server_path)
    } else {
        let message = format!(
            "TeXpresso downloaded adapter {ADAPTER_RELEASE_TAG}, but {} was not created",
            server_path.display()
        );
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::Failed(message.clone()),
        );
        Err(message)
    }
}

/// Give the adapter its regular workspace settings before it sees its first
/// document. Zed also sends the same value through
/// `workspace/didChangeConfiguration`, but that notification can follow an
/// already-open buffer when a worktree becomes trusted. The Node server
/// accepts this small wrapper as well as normal initialization options.
///
/// Standard `lsp.<server>.settings` wins when both settings transports are
/// populated: it is the documented user-facing configuration, while raw
/// initialization options remain a compatibility fallback for other clients.
fn adapter_initialization_options(settings: LspSettings) -> Option<serde_json::Value> {
    settings
        .settings
        .map(|workspace_settings| {
            serde_json::json!({
                "settings": workspace_settings,
            })
        })
        .or(settings.initialization_options)
}

impl zed::Extension for TeXpressoExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if language_server_id.as_ref() != LANGUAGE_SERVER_ID {
            return Err(format!(
                "unknown TeXpresso language server: {language_server_id}"
            ));
        }

        let server_path = install_adapter(language_server_id)?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_path.to_string_lossy().into_owned()],
            env: Vec::new(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let options = LspSettings::for_worktree(LANGUAGE_SERVER_ID, worktree)
            .ok()
            .and_then(adapter_initialization_options);
        Ok(options)
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let settings = LspSettings::for_worktree(LANGUAGE_SERVER_ID, worktree)
            .ok()
            .and_then(|settings| settings.settings)
            .unwrap_or_else(|| serde_json::json!({}));
        // Zed indexes this object for `workspace/configuration` section
        // requests, while also sending the full object on didChangeConfiguration.
        Ok(Some(serde_json::json!({ LANGUAGE_SERVER_ID: settings })))
    }
}

zed::register_extension!(TeXpressoExtension);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_settings_are_available_during_initialization() {
        let settings = LspSettings {
            settings: Some(serde_json::json!({
                "texpressoCommand": "/path with spaces/texpresso",
                "autoStart": true,
            })),
            ..Default::default()
        };

        assert_eq!(
            adapter_initialization_options(settings),
            Some(serde_json::json!({
                "settings": {
                    "texpressoCommand": "/path with spaces/texpresso",
                    "autoStart": true,
                }
            }))
        );
    }

    #[test]
    fn explicit_initialization_options_remain_a_fallback() {
        let options = serde_json::json!({ "extraArgs": ["--legacy"] });
        let settings = LspSettings {
            initialization_options: Some(options.clone()),
            ..Default::default()
        };

        assert_eq!(adapter_initialization_options(settings), Some(options));
    }

    #[test]
    fn workspace_settings_take_precedence_over_legacy_options() {
        let settings = LspSettings {
            initialization_options: Some(serde_json::json!({
                "texpressoCommand": "legacy-texpresso",
            })),
            settings: Some(serde_json::json!({
                "texpressoCommand": "workspace-texpresso",
            })),
            ..Default::default()
        };

        assert_eq!(
            adapter_initialization_options(settings),
            Some(serde_json::json!({
                "settings": {
                    "texpressoCommand": "workspace-texpresso",
                }
            }))
        );
    }

    #[test]
    fn adapter_release_is_pinned_to_a_versioned_asset() {
        assert_eq!(ADAPTER_RELEASE_TAG, "adapter-v0.1.2");
        assert_eq!(ADAPTER_FILE_NAME, "texpresso-live-adapter-v0.1.2.mjs");
        assert_eq!(
            ADAPTER_RELEASE_URL,
            "https://github.com/Maymall/texpresso-zed/releases/download/adapter-v0.1.2/texpresso-live-server.mjs"
        );
    }

    #[test]
    fn new_adapter_filename_does_not_reuse_the_previous_release_cache_entry() {
        let work_directory = Path::new("/zed-extension-work");
        assert_eq!(
            adapter_path_in(work_directory),
            work_directory.join("texpresso-live-adapter-v0.1.2.mjs")
        );
        assert_ne!(
            adapter_path_in(work_directory),
            work_directory.join("texpresso-live-adapter-v0.1.1.mjs")
        );
    }
}
