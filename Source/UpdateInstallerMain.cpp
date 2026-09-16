#include "UpdateInstaller.h"

int main(int argc, char** argv)
{
    if (argc != 3 || !juce::File::isAbsolutePath(juce::String::fromUTF8(argv[2]))) return 2;
    if (juce::String(argv[1]) == "--self-test")
        return UpdateInstaller::selfTest(juce::File(juce::String::fromUTF8(argv[2])));
    if (juce::String(argv[1]) != "--transaction") return 2;
    return UpdateInstaller::runHelper(juce::File(juce::String::fromUTF8(argv[2])));
}
