#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Installer InkyCap",
  description: "Comment télécharger, installer et mettre à jour InkyCap sous Linux, macOS et Windows, y compris le vérificateur de mises à jour intégré et respectueux de la vie privée.",
  tags: ("documentation",),
)

= Installer InkyCap

InkyCap est une application de bureau, installée sur votre propre ordinateur, et non un site web auquel vous vous connectez. Par défaut, tout ce que vous écrivez reste sur votre machine (à moins que vous ne choisissiez explicitement de le partager à l'extérieur).

== Installer selon votre plateforme

InkyCap vise à fonctionner sous Linux, MacOS et Windows. Le fichier que vous téléchargez dépend de votre système.

=== Linux

Sous Linux, vous aurez le choix entre plusieurs formats de package :

- Un *AppImage* (un fichier autonome unique que vous pouvez lancer directement, et le format qui prend en charge les mises à jour automatiques).
- Un package *.deb*, pour les systèmes basés sur Debian et Ubuntu, installé au moyen de vos outils de package habituels.
- Un package *.rpm*, pour les systèmes basés sur Fedora et openSUSE.

L'AppImage est le plus simple si vous voulez que les mises à jour soient gérées dans l'application. Les packages `.deb` et `.rpm` passent par le gestionnaire de packages de votre système et suivent l'apparence native de votre bureau, mais pour l'instant vous devrez télécharger et installer ces mises à jour manuellement.


=== MacOS

Sous MacOS, vous téléchargerez le paquet de l'application et le glisserez dans votre dossier Applications, comme vous le feriez avec la plupart des logiciels Mac.

#callout("important")[
  Les premières versions macOS ne sont pas encore signées ni notariées par Apple. La première fois que vous ouvrirez InkyCap, macOS pourrait vous avertir qu'il provient d'un « développeur non identifié ». C'est normal pour le moment. Vous pouvez tout de même ouvrir l'application en suivant les invites de votre système pour l'autoriser (habituellement dans les paramètres Confidentialité et sécurité), mais ne faites cela que pour un logiciel auquel vous faites confiance et que vous avez téléchargé depuis inkycap.org.
]

=== Windows

Sous Windows, vous lancerez un programme d'installation standard et suivrez les étapes à l'écran. Une fois installé, InkyCap se comporte comme les autres applications Windows et peut se mettre à jour à la demande.

== Ouvrir InkyCap pour la première fois

Après l'installation, lancez InkyCap comme vous lancez n'importe quelle autre application (depuis votre menu d'applications, le Launchpad ou le menu Démarrer). La première chose que vous voudrez faire est de le pointer vers un dossier pour vos notes (votre « boîte de notes »).

Pour une visite guidée de cette première séance (créer une boîte de notes, écrire votre première note et vous repérer), allez directement à #wikilink("4 - Démarrage rapide"). Si vous préférez d'abord comprendre plus en profondeur la notion de boîte de notes, voyez #wikilink("3 - Configurer votre boîte de notes").

== Comment fonctionnent les mises à jour

InkyCap peut vous indiquer lorsqu'une version plus récente est disponible et, sur les plateformes prises en charge, il peut installer la mise à jour pour vous. Il est conçu pour respecter votre vie privée : *InkyCap ne contacte jamais le réseau à moins que vous ne le lui demandiez*.

Vous trouverez tout ce qui touche aux mises à jour dans #wikilink("2 - Paramètres"), sous les sections *Aperçu* et *Comportement*.

=== Vérifier manuellement

1. Ouvrez #wikilink("2 - Paramètres") et allez à la section *Aperçu*.
2. Trouvez la section *Mises à jour logicielles* et cliquez sur *Vérifier les mises à jour*.
3. InkyCap se connecte une seule fois pour voir s'il existe une version plus récente, puis vous le rapporte.

Si vous êtes à jour, vous verrez « Vous utilisez la dernière version. » Si une nouvelle version est disponible, l'étape suivante dépend de la façon dont vous avez installé InkyCap.

=== Installations automatiques ou manuelles

- Sous *Windows*, *macOS* et l'*AppImage Linux*, InkyCap peut télécharger et installer une mise à jour stable sur place. Vous verrez un bouton *Télécharger et installer*, un indicateur de progression pendant le téléchargement, puis « Mise à jour installée. Redémarrez pour terminer. » avec un bouton *Redémarrer maintenant*.
- Sous *Linux .deb / .rpm* (et les installations gérées par package similaires), InkyCap se contente de vous *signaler* qu'une version plus récente existe et propose un bouton *Voir les versions* pour ouvrir la page de téléchargement. La mise à jour proprement dite est laissée au gestionnaire de packages de votre système. L'application ne se remplace jamais à votre insu.

#callout("note")[
  Les versions de développement (bêta) s'installent toujours à la main, même sur les plateformes qui se mettent à jour automatiquement par ailleurs. Si vous adhérez aux bêtas, InkyCap vous dirigera vers la page des versions plutôt que d'en installer une pour vous.
]

=== Vérifier automatiquement au démarrage

Si vous voulez qu'InkyCap cherche les mises à jour de lui-même, vous pouvez l'activer :

1. Ouvrez #wikilink("2 - Paramètres") et allez à la section *Comportement*.
2. Sous *Mises à jour logicielles*, activez *Vérifier les mises à jour au démarrage*.

Cette option est *désactivée par défaut*. Activée, InkyCap vérifie une fois peu après le lancement et affiche un petit message si quelque chose de plus récent est disponible. Il y a aussi une option *Inclure les versions de développement (bêta)* (également désactivée par défaut) si vous voulez être informé des versions préliminaires.

#callout("important")[
  Aucune vérification de mise à jour ne se fait jamais en silence. Une vérification ne s'exécute que lorsque vous cliquez sur le bouton ou lorsque vous avez explicitement choisi la vérification au démarrage. Il n'y a aucune télémétrie et aucune communication en arrière-plan.
]

== Savoir quelle version vous utilisez

Pour voir votre version actuelle, ouvrez #wikilink("2 - Paramètres") et regardez la section *Aperçu*, où le numéro de version est affiché. Les numéros de version d'InkyCap suivent un schéma `année-mois.version.correctif`. Si vous utilisez une version de développement, vous verrez un petit badge *Version de développement* à côté du numéro, de sorte que vous savez toujours si vous êtes sur une copie stable ou préliminaire.

== Obtenir de l'aide

La section *Aperçu* de #wikilink("2 - Paramètres") inclut aussi une rubrique *Aide* avec un lien vers la documentation d'InkyCap. C'est un bon endroit où revenir chaque fois que vous voulez en apprendre davantage sur une fonctionnalité.

== Pages connexes

- #wikilink("4 - Démarrage rapide")
- #wikilink("3 - Configurer votre boîte de notes")
- #wikilink("2 - Paramètres")
- #wikilink("1 - Prise en main")
- #wikilink("1 - L'interface InkyCap")
