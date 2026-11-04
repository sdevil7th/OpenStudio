// Separate, user-launched executable. Never linked into or invoked by the DAW.
#import <Cocoa/Cocoa.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    @autoreleasepool {
        NSString *bundle = NSBundle.mainBundle.bundlePath;
#ifdef OPENSTUDIO_SUPPORT_SHORTCUT
        NSString *target = [[bundle stringByDeletingLastPathComponent]
            stringByAppendingPathComponent:@"OpenStudio.app/Contents/Helpers/OpenStudioSupport.app/Contents/MacOS/OpenStudioSupport"];
#else
#if defined(__arm64__)
        NSString *architecture = @"arm64";
#else
        NSString *architecture = @"x86_64";
#endif
        NSString *target = [bundle stringByAppendingPathComponent:
            [NSString stringWithFormat:@"Contents/Helpers/%@/OpenStudioSupport.app/Contents/MacOS/OpenStudioSupport", architecture]];
#endif
        char **arguments = calloc((size_t)argc + 1, sizeof(char *));
        if (arguments != NULL) {
            arguments[0] = (char *)target.fileSystemRepresentation;
            for (int index = 1; index < argc; ++index) arguments[index] = argv[index];
            execv(arguments[0], arguments);
            free(arguments);
        }
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"OpenStudio Support could not open";
        alert.informativeText = @"Keep OpenStudio.app and OpenStudio Support.app together in Applications. Reinstall both from the same download if the support files are missing.";
        [alert runModal];
        return 1;
    }
}
