// TODO: Placeholder component - Menu items not yet functional
export function MenuBar() {
  const menuItems = [
    "File",
    "Edit",
    "View",
    "Insert",
    "Item",
    "Track",
    "Options",
    "Actions",
    "Help",
  ];

  return (
    <div className="h-6 bg-neutral-900 border-b border-neutral-700 flex px-1 text-[13px] shrink-0">
      {menuItems.map((item) => (
        <button
          key={item}
          className="bg-transparent border-none text-neutral-300 px-3 cursor-pointer text-[13px] transition-colors
                               hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled
          title={`${item} menu (TODO)`}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
