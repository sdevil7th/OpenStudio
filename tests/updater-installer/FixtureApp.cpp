#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <chrono>

// Disposable process used only by the installer qualification target. It has
// no audio, project access, network, or production update key.
int main(int argc, char** argv)
{
    std::string receipt;
    if (const auto* path = std::getenv("OPENSTUDIO_UPDATE_RECEIPT")) receipt = path;
    for (int i = 1; i + 1 < argc; ++i)
        if (std::string(argv[i]) == "--openstudio-update-receipt") receipt = argv[i + 1];
    if (receipt.empty()) return 0; // Previous version relaunched after rollback.
    const auto dir = std::filesystem::path(receipt);
    std::ifstream input(dir / "fixture-behaviour");
    std::string mode; input >> mode;
    if (mode == "exit") return 3;
    if (mode == "late")
    {
        std::this_thread::sleep_for(std::chrono::seconds(7));
        return 0;
    }
    std::ofstream(dir / "healthy") << "999.1.1";
    return 0;
}
